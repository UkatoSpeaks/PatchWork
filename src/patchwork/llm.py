"""Async wrapper around LiteLLM.

Adds what the agents need on top of ``litellm.acompletion``:
- normalized tool calls and per-call token accounting,
- 429 handling that tells per-minute limits (TPM/RPM) from per-day ones
  (TPD/RPD) by Groq's error message. Per-minute: retry, honouring the
  provider's retry-after hint (else exponential backoff with jitter), until
  the call has waited ``max_wait`` seconds in total. Per-day: no retry; the
  model is marked exhausted and ``DailyLimitReached`` is raised so the agent
  can switch to a fallback model.
- 400 errors raised as ``BadRequest``, carrying Groq's ``failed_generation``
  (what the model actually wrote) when there is one,
- per-model state shared by every agent in the process: a semaphore capping
  in-flight requests, a cooldown so that when one agent gets a 429 the others
  on that model wait it out too, the exhausted flag, and the token budget
  from the ``x-ratelimit-*`` response headers, used to wait for the
  per-minute budget instead of sending a call that would get a 429. By
  default ("proportional") the budget is assumed to refill gradually, so a
  call waits only for the tokens it lacks; after a per-minute 429 that this
  assumption let through, the model falls back to waiting for the full reset,
- optional daily usage accounting (``usage.UsageStore``).
"""

from __future__ import annotations

import asyncio
import email.utils
import json
import logging
import os
import random
import re
import time
import weakref
from collections.abc import Awaitable, Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from patchwork.usage import UsageStore

log = logging.getLogger(__name__)

CompletionFn = Callable[..., Awaitable[Any]]
# (model, attempt, delay, exception) when this call is rate limited and retries.
RetryCallback = Callable[[str, int, float, BaseException], None]
# (model, delay) when a call waits out a cooldown set by another call's 429.
CooldownCallback = Callable[[str, float], None]
# (model, delay, estimated tokens, remaining tokens, limit, mode) when a call waits for the per-minute token budget.
ThrottleCallback = Callable[[str, float, int, int, int, str], None]
# (model) when proportional throttling is abandoned for a model after a 429.
ThrottleFallbackCallback = Callable[[str], None]

ThrottleMode = Literal["proportional", "full"]

# Length of a per-minute token window, used once we assume a window has reset.
TOKEN_WINDOW_SECONDS = 60.0
# Added to a proportional wait so the refill has surely covered the call.
PROPORTIONAL_MARGIN_SECONDS = 1.0

# Name of the agent making LLM calls in the current task, for attributing
# rate-limit waits. Each asyncio task gets its own copy.
llm_caller: ContextVar[str | None] = ContextVar("patchwork_llm_caller", default=None)


@dataclass
class TokenBudget:
    """One model's per-minute token budget, from the latest response headers.

    Times are on the client's monotonic clock. Groq's ``x-ratelimit-*-tokens``
    headers describe the per-minute (TPM) limit, ``*-requests`` the per-day one.
    """

    limit_tokens: int | None = None
    remaining_tokens: int | None = None
    tokens_reset_at: float | None = None
    limit_requests: int | None = None
    remaining_requests: int | None = None
    requests_reset_at: float | None = None
    # When ``remaining_tokens`` was last brought up to date (headers or refill).
    tokens_as_of: float | None = None
    # Whether ``remaining_tokens`` includes assumed refill since the headers.
    refill_credited: bool = False

    def update(self, headers: Mapping[str, str], now: float) -> None:
        def number(key: str) -> int | None:
            try:
                return int(float(headers[key]))
            except (KeyError, ValueError):
                return None

        def reset(key: str) -> float | None:
            seconds = parse_duration(headers.get(key, ""))
            return now + seconds if seconds is not None else None

        if (remaining := number("x-ratelimit-remaining-tokens")) is not None:
            self.remaining_tokens = remaining
            self.limit_tokens = number("x-ratelimit-limit-tokens") or self.limit_tokens
            self.tokens_reset_at = reset("x-ratelimit-reset-tokens")
            self.tokens_as_of = now
            self.refill_credited = False
        if (remaining := number("x-ratelimit-remaining-requests")) is not None:
            self.remaining_requests = remaining
            self.limit_requests = number("x-ratelimit-limit-requests") or self.limit_requests
            self.requests_reset_at = reset("x-ratelimit-reset-requests")

    def wait_for(self, tokens: int, now: float, mode: ThrottleMode = "full") -> float:
        """Seconds to wait before a call costing ``tokens`` fits the budget (0 = send now).

        "full": wait until the reset time from the headers. "proportional": the
        budget refills at ``limit / 60s`` (token bucket), so wait
        ``(tokens - remaining) / rate`` plus a margin, capped at the reset time.
        """
        if self.remaining_tokens is None or self.limit_tokens is None:
            return 0.0
        if self.tokens_reset_at is not None and now >= self.tokens_reset_at:
            # The window has reset since the headers were read.
            self.remaining_tokens = self.limit_tokens
            self.tokens_reset_at = now + TOKEN_WINDOW_SECONDS
            self.tokens_as_of = now
            self.refill_credited = False
        rate = self.limit_tokens / TOKEN_WINDOW_SECONDS
        if mode == "proportional" and self.tokens_as_of is not None and now > self.tokens_as_of:
            # Credit what has refilled since the budget was last brought up to date.
            refilled = min(self.limit_tokens - self.remaining_tokens, int((now - self.tokens_as_of) * rate))
            if refilled > 0:
                self.remaining_tokens += refilled
                self.refill_credited = True
            self.tokens_as_of = now
        if self.remaining_tokens >= tokens or tokens > self.limit_tokens:
            # Fits, or can never fit (let the provider answer).
            return 0.0
        until_reset = self.tokens_reset_at - now if self.tokens_reset_at is not None else None
        if mode == "full":
            return until_reset or 0.0  # no reset time to wait for: send now
        wait = (tokens - self.remaining_tokens) / rate + PROPORTIONAL_MARGIN_SECONDS
        return min(wait, until_reset) if until_reset is not None else wait

    def reserve(self, tokens: int) -> None:
        """Count a call being sent, so concurrent calls see the budget it uses."""
        if self.remaining_tokens is not None:
            self.remaining_tokens = max(0, self.remaining_tokens - tokens)


class _ModelGate:
    """Per-model state shared by all clients in one event loop."""

    def __init__(self, max_concurrency: int) -> None:
        self.semaphore = asyncio.Semaphore(max_concurrency)
        self.cooldown_until = 0.0
        self.budget = TokenBudget()
        # Set once a per-minute 429 shows proportional throttling sends too early.
        self.full_throttle_only = False
        # Set once the model hits a per-day limit; it stays exhausted from then on.
        self.exhausted: DailyLimitReached | None = None


# Keyed by event loop: asyncio primitives must not be shared across loops.
# The CLI runs one event loop per process, so this is per-process state.
_GATES: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, _ModelGate]] = weakref.WeakKeyDictionary()


def _gate_for(model: str, max_concurrency: int) -> _ModelGate:
    gates = _GATES.setdefault(asyncio.get_running_loop(), {})
    if model not in gates:
        gates[model] = _ModelGate(max_concurrency)
    return gates[model]


class TokenUsage(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def __add__(self, other: TokenUsage) -> TokenUsage:
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
        )


class ToolCall(BaseModel):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    # Set when the model's argument string was not a JSON object.
    parse_error: str | None = None


class LLMResponse(BaseModel):
    model: str
    content: str | None = None
    tool_calls: list[ToolCall] = Field(default_factory=list)
    usage: TokenUsage = Field(default_factory=TokenUsage)
    finish_reason: str | None = None

    def to_message(self) -> dict[str, Any]:
        """The assistant message to append to the conversation history."""
        message: dict[str, Any] = {"role": "assistant", "content": self.content or None}
        if self.tool_calls:
            message["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
                }
                for call in self.tool_calls
            ]
        elif message["content"] is None:
            message["content"] = ""
        return message


class CallRecord(BaseModel):
    model: str
    usage: TokenUsage
    retries: int
    latency_seconds: float


class LLMError(RuntimeError):
    pass


class RateLimitExhausted(LLMError):
    """Still rate limited by a per-minute limit after waiting ``max_wait`` seconds in total."""


class DailyLimitReached(LLMError):
    """The model hit a per-day limit (TPD/RPD). Never retried: the model stays exhausted."""

    def __init__(self, model: str, message: str, retry_after: float | None = None,
                 reset_at: datetime | None = None, limit_name: str | None = None) -> None:
        super().__init__(f"daily limit reached on {model}: {message}")
        self.model = model
        self.provider_message = message
        # Seconds until the provider said to try again, and that local time.
        self.retry_after = retry_after
        self.reset_at = reset_at
        # e.g. "tokens per day (TPD)"
        self.limit_name = limit_name

    def describe(self) -> str:
        """e.g. "groq/openai/gpt-oss-120b (tokens per day (TPD), resets in 3m29s, around 17:35)"."""
        parts = [self.limit_name or "per-day limit"]
        if self.retry_after is not None:
            when = f"resets in {format_duration(self.retry_after)}"
            if self.reset_at is not None:
                when += f", around {self.reset_at:%H:%M}"
            parts.append(when)
        return f"{self.model} ({', '.join(parts)})"


class AllModelsExhausted(LLMError):
    """Every model an agent may use has hit its per-day limit."""

    def __init__(self, role: str, limits: list[DailyLimitReached]) -> None:
        super().__init__(
            f"daily limit reached on every model the {role} may use: "
            + "; ".join(limit.describe() for limit in limits)
            + f". Try again after the reset, or add models to {role.upper()}_FALLBACKS."
        )
        self.role = role
        self.limits = limits


class BadRequest(LLMError):
    """The provider rejected the request (HTTP 400).

    ``code`` is the provider's error code (Groq: ``tool_use_failed``,
    ``output_parse_failed``, ...). ``failed_generation`` is what the model
    actually produced, when the provider reports it; often it is a final
    answer, a thought or a tool call written as text.
    """

    def __init__(self, message: str, failed_generation: str | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.failed_generation = failed_generation
        self.code = code


class LLMClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        max_concurrency: int = 2,
        max_wait: float = 180.0,
        base_backoff: float = 2.0,
        max_backoff: float = 90.0,
        completion_fn: CompletionFn | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        usage: UsageStore | None = None,
        on_retry: RetryCallback | None = None,
        on_cooldown: CooldownCallback | None = None,
        on_throttle: ThrottleCallback | None = None,
        on_throttle_fallback: ThrottleFallbackCallback | None = None,
        throttle_mode: ThrottleMode = "proportional",
    ) -> None:
        """``max_concurrency`` caps in-flight requests per model; the first
        client to use a model in an event loop sets that model's cap.

        ``max_wait`` bounds the seconds one call spends waiting on per-minute
        limits in total (retries, shared cooldowns, throttling): a 429 that
        would take it past that gives up with ``RateLimitExhausted``.
        ``base_backoff`` / ``max_backoff`` apply only when the provider gives
        no retry-after hint.

        ``throttle_mode`` is how long a call waits when the per-minute token
        budget from the headers can't cover it (see ``TokenBudget.wait_for``).
        In "proportional" mode, a per-minute 429 on a call sent on assumed
        refill switches that model to "full" for the rest of the process."""
        self._api_key = api_key
        self.max_concurrency = max_concurrency
        self._completion_fn = completion_fn or _litellm_acompletion()
        self._sleep = sleep
        self._clock = clock
        self.max_wait = max_wait
        self.base_backoff = base_backoff
        self.max_backoff = max_backoff
        self.usage = usage
        self.on_retry = on_retry
        self.on_cooldown = on_cooldown
        self.on_throttle = on_throttle
        self.on_throttle_fallback = on_throttle_fallback
        self.throttle_mode = throttle_mode
        self.calls: list[CallRecord] = []

    @property
    def total_usage(self) -> TokenUsage:
        total = TokenUsage()
        for record in self.calls:
            total = total + record.usage
        return total

    async def complete(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        *,
        tool_choice: str | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.0,
    ) -> LLMResponse:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "num_retries": 0,  # retries are handled here, not by LiteLLM
        }
        if tools:
            kwargs["tools"] = tools
            if tool_choice:
                kwargs["tool_choice"] = tool_choice
        if max_tokens:
            kwargs["max_tokens"] = max_tokens
        if self._api_key:
            kwargs["api_key"] = self._api_key

        gate = _gate_for(model, self.max_concurrency)
        if gate.exhausted is not None:
            raise gate.exhausted
        estimate = estimate_tokens(messages, tools, max_tokens)
        started = time.monotonic()
        attempt = 0
        waited = 0.0
        just_backed_off = False
        while True:
            # Wait out a cooldown another call on this model hit (our own
            # backoff sleep already covered the one we set).
            remaining = gate.cooldown_until - self._clock()
            if remaining > 0 and not just_backed_off:
                if self.on_cooldown:
                    self.on_cooldown(model, remaining)
                await self._sleep(remaining)
                waited += remaining
            just_backed_off = False
            # Don't send a call the per-minute token budget can't cover.
            mode: ThrottleMode = "full" if gate.full_throttle_only else self.throttle_mode
            throttle = gate.budget.wait_for(estimate, self._clock(), mode)
            if throttle > 0:
                remaining_tokens = gate.budget.remaining_tokens or 0
                limit_tokens = gate.budget.limit_tokens or 0
                if self.on_throttle:
                    self.on_throttle(model, throttle, estimate, remaining_tokens, limit_tokens, mode)
                log.info("throttling (%s): waiting %.1fs for the token budget on %s (need ~%d, %d left, limit %d/min)",
                         mode, throttle, model, estimate, remaining_tokens, limit_tokens)
                await self._sleep(throttle)
                waited += throttle
                continue
            # Sent on tokens assumed to have refilled since the last headers.
            on_assumed_refill = mode == "proportional" and gate.budget.refill_credited
            gate.budget.reserve(estimate)
            try:
                async with gate.semaphore:
                    raw = await self._completion_fn(**kwargs)
                break
            except Exception as exc:
                gate.budget.update(_headers_of(exc), self._clock())
                if _is_bad_request(exc):
                    raise BadRequest(str(exc), _failed_generation(exc), _error_code(exc)) from exc
                if not _is_rate_limit(exc):
                    raise
                if limit_period(exc) == "day":
                    gate.exhausted = self._daily_limit(model, exc)
                    raise gate.exhausted from exc
                if on_assumed_refill and not gate.full_throttle_only:
                    gate.full_throttle_only = True
                    log.warning("proportional throttling not accepted on %s; using full reset waits", model)
                    if self.on_throttle_fallback:
                        self.on_throttle_fallback(model)
                delay = self._retry_delay(exc, attempt)
                if waited + delay > self.max_wait:
                    raise RateLimitExhausted(
                        f"still rate limited on {model} after waiting {waited:.0f}s in total "
                        f"({attempt} retries; the limit is {self.max_wait:.0f}s): {exc}"
                    ) from exc
                gate.cooldown_until = max(gate.cooldown_until, self._clock() + delay)
                attempt += 1
                log.info("rate limited on %s; retry %d in %.1fs", model, attempt, delay)
                if self.on_retry:
                    self.on_retry(model, attempt, delay, exc)
                # Sleep outside the semaphore so other requests are not blocked on us.
                await self._sleep(delay)
                waited += delay
                just_backed_off = True

        gate.budget.update(_response_headers(raw), self._clock())
        response = _parse_response(raw, model)
        self.calls.append(
            CallRecord(
                model=model,
                usage=response.usage,
                retries=attempt,
                latency_seconds=time.monotonic() - started,
            )
        )
        if self.usage is not None:
            self.usage.record(model, response.usage.prompt_tokens, response.usage.completion_tokens)
            if gate.budget.limit_requests is not None:
                self.usage.note_reported(model, requests_per_day=gate.budget.limit_requests)
        return response

    def _daily_limit(self, model: str, exc: BaseException) -> DailyLimitReached:
        message = _error_message(exc)
        retry_after = retry_after_seconds(exc)
        reset_at = datetime.fromtimestamp(time.time() + retry_after) if retry_after is not None else None
        details = parse_limit_message(message)
        if self.usage is not None and details.get("kind") == "TPD":
            self.usage.note_reported(model, used_tokens=details.get("used"), tokens_per_day=details.get("limit"))
        elif self.usage is not None and details.get("kind") == "RPD":
            self.usage.note_reported(model, requests_per_day=details.get("limit"))
        log.warning("daily limit reached on %s: %s", model, message)
        return DailyLimitReached(model, message, retry_after, reset_at, details.get("name"))

    def _retry_delay(self, exc: BaseException, attempt: int) -> float:
        hinted = retry_after_seconds(exc)
        if hinted is not None:
            # Always honour the hint, with a small pad to land just after the window resets.
            return hinted + 0.5
        backoff = min(self.max_backoff, self.base_backoff * 2**attempt)
        return backoff * random.uniform(1.0, 1.25)


def _litellm_acompletion() -> CompletionFn:
    # Use the bundled model-cost map instead of fetching it over the network on import.
    os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
    import litellm

    litellm.suppress_debug_info = True
    return litellm.acompletion


def _status_code(exc: BaseException) -> int | None:
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def _is_rate_limit(exc: BaseException) -> bool:
    return _status_code(exc) == 429 or type(exc).__name__ == "RateLimitError"


def _is_bad_request(exc: BaseException) -> bool:
    return _status_code(exc) == 400 or type(exc).__name__ == "BadRequestError"


def _error_body(exc: BaseException) -> dict[str, Any]:
    """The ``error`` object of a 'GroqException - {json}' message, or {}."""
    text = str(exc)
    start = text.find("{")
    while start >= 0:
        try:
            body, _ = json.JSONDecoder().raw_decode(text, start)
        except json.JSONDecodeError:
            start = text.find("{", start + 1)
            continue
        error = body.get("error", body) if isinstance(body, dict) else None
        return error if isinstance(error, dict) else {}
    return {}


def _failed_generation(exc: BaseException) -> str | None:
    generation = _error_body(exc).get("failed_generation")
    return generation if isinstance(generation, str) and generation.strip() else None


def _error_code(exc: BaseException) -> str | None:
    code = _error_body(exc).get("code")
    return str(code) if code else None


def _error_message(exc: BaseException) -> str:
    message = _error_body(exc).get("message")
    return message if isinstance(message, str) and message else str(exc)


# "... on tokens per day (TPD): Limit 200000, Used 197532, Requested 2952. ..."
_LIMIT_RE = re.compile(
    r"on\s+(?P<name>[a-z ]+?\s*\((?P<kind>[A-Z]{3})\))\s*:\s*Limit\s+(?P<limit>\d+)"
    r"(?:,\s*Used\s+(?P<used>\d+))?(?:,\s*Requested\s+(?P<requested>\d+))?",
    re.IGNORECASE,
)
_DAY_RE = re.compile(r"\((?:TPD|RPD)\)|per day", re.IGNORECASE)


def parse_limit_message(message: str) -> dict[str, Any]:
    """Groq's 429 message as {"name", "kind" (TPM/RPM/TPD/RPD), "limit", "used", "requested"}; {} if unknown."""
    match = _LIMIT_RE.search(message)
    if not match:
        return {}
    out: dict[str, Any] = {"name": " ".join(match["name"].split()), "kind": match["kind"].upper()}
    for key in ("limit", "used", "requested"):
        if match[key] is not None:
            out[key] = int(match[key])
    return out


def limit_period(exc: BaseException) -> Literal["minute", "day"]:
    """Which kind of limit a 429 hit, from the provider's message; unknown counts as per-minute."""
    return "day" if _DAY_RE.search(str(exc)) else "minute"


def estimate_tokens(messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None, max_tokens: int | None) -> int:
    """What a call counts against a tokens-per-minute budget: prompt characters / 4
    plus ``max_tokens`` (Groq counts the completion cap up front)."""
    chars = len(json.dumps(messages, default=str)) + (len(json.dumps(tools, default=str)) if tools else 0)
    return chars // 4 + (max_tokens or 0)


def _headers_of(exc: BaseException) -> dict[str, str]:
    return _collect_headers(
        lambda: getattr(exc, "litellm_response_headers", None),
        lambda: getattr(getattr(exc, "response", None), "headers", None),
        lambda: getattr(exc, "headers", None),
    )


def _response_headers(raw: Any) -> dict[str, str]:
    """Provider headers of a LiteLLM response (``x-ratelimit-*`` and friends)."""
    hidden = getattr(raw, "_hidden_params", None)
    hidden = hidden if isinstance(hidden, dict) else {}
    return _collect_headers(
        lambda: hidden.get("additional_headers"),
        lambda: hidden.get("headers"),
        lambda: getattr(raw, "_response_headers", None),
    )


def _collect_headers(*getters: Callable[[], Any]) -> dict[str, str]:
    """Lower-cased headers, first source wins; LiteLLM's ``llm_provider-``
    copies are also stored without the prefix."""
    headers: dict[str, str] = {}
    sources = []
    for getter in getters:
        try:
            sources.append(getter())
        except Exception:
            continue
    for source in sources:
        if not source:
            continue
        try:
            items = dict(source).items()
        except (TypeError, ValueError):
            continue
        for key, value in items:
            key = str(key).lower()
            headers.setdefault(key, str(value))
            if key.startswith("llm_provider-"):
                headers.setdefault(key.removeprefix("llm_provider-"), str(value))
    return headers


_TRY_AGAIN_RE = re.compile(r"try again in\s+([0-9hms.]+)", re.IGNORECASE)
_DURATION_PART_RE = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")
_UNIT_SECONDS = {"ms": 0.001, "s": 1.0, "m": 60.0, "h": 3600.0}


def retry_after_seconds(exc: BaseException, now: float | None = None) -> float | None:
    """Seconds the provider asked us to wait, or None if it gave no hint.

    Checks ``retry-after-ms`` and ``retry-after`` headers (seconds or HTTP date,
    also LiteLLM's ``llm_provider-`` prefixed copies), then Groq's
    "Please try again in 7.5s" message text.
    """
    headers = _headers_of(exc)
    for key in ("retry-after-ms", "llm_provider-retry-after-ms"):
        if key in headers:
            try:
                return max(0.0, float(headers[key]) / 1000)
            except ValueError:
                pass
    for key in ("retry-after", "llm_provider-retry-after"):
        if key in headers:
            value = headers[key].strip()
            try:
                return max(0.0, float(value))
            except ValueError:
                pass
            try:
                when = email.utils.parsedate_to_datetime(value).timestamp()
            except (TypeError, ValueError):
                continue
            return max(0.0, when - (now if now is not None else time.time()))

    match = _TRY_AGAIN_RE.search(str(exc))
    if match:
        return parse_duration(match.group(1))
    return None


def parse_duration(text: str) -> float | None:
    """Groq-style durations: "7.66s", "1m23.5s", "250ms", "2h0m3s"; a bare number is seconds."""
    text = text.strip()
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    parts = _DURATION_PART_RE.findall(text)
    if not parts:
        return None
    return sum(float(n) * _UNIT_SECONDS[unit] for n, unit in parts)


def format_duration(seconds: float) -> str:
    """3m29s, 45s, 2h05m."""
    seconds = max(0, round(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    return f"{minutes}m{secs:02d}s" if minutes else f"{secs}s"


def _parse_response(raw: Any, model: str) -> LLMResponse:
    choice = raw.choices[0]
    message = choice.message
    tool_calls: list[ToolCall] = []
    for index, call in enumerate(getattr(message, "tool_calls", None) or []):
        raw_args = call.function.arguments or "{}"
        arguments: dict[str, Any] = {}
        parse_error = None
        try:
            parsed = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            if isinstance(parsed, dict):
                arguments = parsed
            else:
                parse_error = "arguments must be a JSON object"
        except json.JSONDecodeError as exc:
            parse_error = str(exc)
        tool_calls.append(
            ToolCall(
                id=call.id or f"call_{index}",
                name=call.function.name,
                arguments=arguments,
                parse_error=parse_error,
            )
        )

    usage = getattr(raw, "usage", None)
    return LLMResponse(
        model=model,
        content=getattr(message, "content", None),
        tool_calls=tool_calls,
        usage=TokenUsage(
            prompt_tokens=getattr(usage, "prompt_tokens", 0) or 0,
            completion_tokens=getattr(usage, "completion_tokens", 0) or 0,
        ),
        finish_reason=getattr(choice, "finish_reason", None),
    )
