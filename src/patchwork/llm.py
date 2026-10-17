"""Async wrapper around LiteLLM.

Adds what the agents need on top of ``litellm.acompletion``:
- normalized tool calls and per-call token accounting,
- retries on rate-limit (429) errors that honour the provider's retry-after
  hint, falling back to exponential backoff with jitter,
- an ``asyncio.Semaphore`` capping concurrent in-flight requests.
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
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

CompletionFn = Callable[..., Awaitable[Any]]
RetryCallback = Callable[[int, float, BaseException], None]


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
    """Still rate limited after all retries."""


class MalformedToolCall(LLMError):
    """The provider rejected the model's output as a bad tool call (Groq: tool_use_failed).

    ``failed_generation`` is what the model actually produced, when the provider
    reports it; often it is a final answer written as text instead of a tool call.
    """

    def __init__(self, message: str, failed_generation: str | None = None) -> None:
        super().__init__(message)
        self.failed_generation = failed_generation


class LLMClient:
    def __init__(
        self,
        *,
        api_key: str | None = None,
        max_concurrency: int = 2,
        max_retries: int = 6,
        base_backoff: float = 2.0,
        max_backoff: float = 90.0,
        completion_fn: CompletionFn | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        on_retry: RetryCallback | None = None,
    ) -> None:
        self._api_key = api_key
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._completion_fn = completion_fn or _litellm_acompletion()
        self._sleep = sleep
        self.max_retries = max_retries
        self.base_backoff = base_backoff
        self.max_backoff = max_backoff
        self.on_retry = on_retry
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

        started = time.monotonic()
        attempt = 0
        while True:
            try:
                async with self._semaphore:
                    raw = await self._completion_fn(**kwargs)
                break
            except Exception as exc:
                if _is_tool_use_failed(exc):
                    raise MalformedToolCall(str(exc), _failed_generation(exc)) from exc
                if not _is_rate_limit(exc):
                    raise
                if attempt >= self.max_retries:
                    raise RateLimitExhausted(
                        f"still rate limited after {attempt} retries: {exc}"
                    ) from exc
                delay = self._retry_delay(exc, attempt)
                attempt += 1
                log.info("rate limited on %s; retry %d in %.1fs", model, attempt, delay)
                if self.on_retry:
                    self.on_retry(attempt, delay, exc)
                # Sleep outside the semaphore so other requests are not blocked on us.
                await self._sleep(delay)

        response = _parse_response(raw, model)
        self.calls.append(
            CallRecord(
                model=model,
                usage=response.usage,
                retries=attempt,
                latency_seconds=time.monotonic() - started,
            )
        )
        return response

    def _retry_delay(self, exc: BaseException, attempt: int) -> float:
        hinted = retry_after_seconds(exc)
        if hinted is not None:
            # Small pad so we land just after the window resets.
            return min(hinted + 0.5, self.max_backoff)
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


def _is_tool_use_failed(exc: BaseException) -> bool:
    return _status_code(exc) == 400 and "tool_use_failed" in str(exc)


def _failed_generation(exc: BaseException) -> str | None:
    """Pull ``error.failed_generation`` out of a 'GroqException - {json}' message."""
    text = str(exc)
    start = text.find("{")
    if start < 0:
        return None
    try:
        body, _ = json.JSONDecoder().raw_decode(text, start)
    except json.JSONDecodeError:
        return None
    error = body.get("error") if isinstance(body, dict) else None
    generation = error.get("failed_generation") if isinstance(error, dict) else None
    return generation if isinstance(generation, str) and generation.strip() else None


def _headers_of(exc: BaseException) -> dict[str, str]:
    headers: dict[str, str] = {}
    sources = []
    for getter in (
        lambda: getattr(exc, "litellm_response_headers", None),
        lambda: getattr(getattr(exc, "response", None), "headers", None),
        lambda: getattr(exc, "headers", None),
    ):
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
            headers.setdefault(str(key).lower(), str(value))
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
        parts = _DURATION_PART_RE.findall(match.group(1))
        if parts:
            return sum(float(n) * _UNIT_SECONDS[unit] for n, unit in parts)
    return None


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
