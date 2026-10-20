"""Generic tool-using agent loop.

An ``Agent`` repeatedly calls the LLM, executes the tool calls it asks for and
feeds the results back, until it calls the built-in ``finish`` tool or runs out
of steps or tokens. Roles (coder, tester, reviewer, lead) differ only in their
model, system prompt and tool list.

Agents that must return structured data (the lead's plan, the reviewer's
verdict) get a ``SubmitSpec``: they end by calling a submit tool whose
arguments are validated against a pydantic model, with a few retries.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections.abc import Callable, Sequence
from typing import Any, Literal, NamedTuple, Protocol

import json_repair
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from patchwork.llm import AllModelsExhausted, BadRequest, DailyLimitReached, LLMResponse, TokenUsage, ToolCall

FINISH_TOOL = "finish"
# Consecutive HTTP 400s on one model (with or without a failed_generation) after
# which the agent switches to its next model.
MAX_BAD_REQUESTS_PER_MODEL = 3
# With no model left to switch to, consecutive 400s without a failed_generation
# are retried this many times before the agent fails.
MAX_BAD_REQUEST_RETRIES = MAX_BAD_REQUESTS_PER_MODEL - 1
# The Nth identical tool call (same name and arguments) whose result has not
# changed is not run; the agent is told to do something different.
REPEAT_CALL_LIMIT = 3
DEFAULT_REPEAT_HINT = "the result is already in your context above; use it, or call a different tool or change the arguments."
ELIDE_KEEP_CHARS = 300
ELIDED_MARK = "\n[…older output elided to save tokens; re-run the tool if you need it]"


class ToolOutput(BaseModel):
    content: str
    # One-line description for logs; defaults to the start of ``content``.
    summary: str | None = None
    files_changed: list[str] = Field(default_factory=list)
    is_error: bool = False
    # Identifies a read-only view (a file page, a search). The latest result per
    # key stays in full in the history, older ones are stubbed, and an identical
    # repeat is replaced by a pointer to the earlier result.
    view_key: str | None = None
    # For views of data that can change (a file): a fingerprint of the data and
    # the 1-based line span shown. A later view of the same key and version
    # whose span is already covered gets the short note instead.
    view_version: str | None = None
    view_span: tuple[int, int] | None = None
    # Set by a tool that has itself verified the task is complete: the run ends
    # with success and this summary.
    finish_summary: str | None = None


class Tool(BaseModel):
    """A function the LLM may call. Arguments are validated by ``args_model``."""

    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    name: str
    description: str
    args_model: type[BaseModel]
    # Takes an ``args_model`` instance; returns str or ToolOutput (sync or async).
    handler: Callable[[Any], Any]

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": _json_schema(self.args_model),
            },
        }

    async def invoke(self, arguments: dict[str, Any]) -> ToolOutput:
        args = self.args_model.model_validate(arguments)
        if inspect.iscoroutinefunction(self.handler):
            out = await self.handler(args)
        else:
            # Tools do blocking I/O (files, subprocesses); keep the event loop free.
            out = await asyncio.to_thread(self.handler, args)
        return out if isinstance(out, ToolOutput) else ToolOutput(content=str(out))


class FinishArgs(BaseModel):
    success: bool = Field(description="true only if the task is done and verified")
    summary: str = Field(description="1-3 sentences: what you changed and why")


FINISH = Tool(
    name=FINISH_TOOL,
    description="End the task and report the outcome.",
    args_model=FinishArgs,
    handler=lambda args: "ok",
)


class SubmitSpec(BaseModel):
    """A structured final answer: the agent ends by calling ``name`` with
    arguments that validate against ``schema_model``. Invalid arguments are
    sent back with the validation error, up to ``max_retries`` times."""

    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    name: str
    description: str
    schema_model: type[BaseModel]
    max_retries: int = 2
    # Field of the validated payload used as the AgentResult summary.
    summary_field: str = "summary"
    # Passed to ``model_validate`` as the validation context.
    context: dict[str, Any] | None = None

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": _json_schema(self.schema_model)},
        }


class AgentEvent(BaseModel):
    """Emitted as the agent works. The orchestrator turns these into bus events.

    Kinds: ``llm_call`` (one completion, with its token usage), ``thought``
    (text the model wrote), ``tool_called`` (before a tool runs),
    ``tool_result`` (after), ``note`` (nudges, alias mappings, rejections,
    auto-finish), ``model_switch`` (the agent moved to its next model;
    ``arguments`` has ``from``, ``to`` and ``reason``: "daily_limit" or
    "bad_requests") and ``finish`` (the agent's last step).
    """

    role: str
    step: int
    kind: Literal["llm_call", "thought", "tool_called", "tool_result", "note", "model_switch", "finish"]
    tool: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""
    is_error: bool = False
    # Running total for the agent; for llm_call also this call's usage.
    tokens_used: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0


# "daily_limit": every model the agent may use hit its per-day limit.
# "cancelled": stopped by the orchestrator (e.g. its parallel sibling failed).
StopReason = Literal["finished", "max_steps", "max_tokens", "invalid_output", "error", "daily_limit", "cancelled"]


class AgentResult(BaseModel):
    role: str
    success: bool
    summary: str
    files_changed: list[str]
    steps_used: int
    tokens_used: int
    prompt_tokens: int
    completion_tokens: int
    stop_reason: StopReason
    # The validated submit payload, for agents with a SubmitSpec.
    output: dict[str, Any] | None = None
    # Models the agent actually called, in order (more than one after a fallback).
    models_used: list[str] = Field(default_factory=list)


class SupportsComplete(Protocol):
    async def complete(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        *,
        tool_choice: str | None = None,
        max_tokens: int | None = None,
    ) -> LLMResponse: ...


EventCallback = Callable[[AgentEvent], None]


# (tool name, arguments) -> a hint for an agent repeating that call, or None for the default.
RepeatHint = Callable[[str, dict[str, Any]], str | None]


class _Repeat(NamedTuple):
    """The latest run of one exact tool call."""

    # Consecutive runs that returned this same content.
    count: int
    content: str
    # The agent's file-change counter after that run.
    edits: int


class _View(NamedTuple):
    key: str
    step: int
    version: str | None
    span: tuple[int, int] | None


def _covers(old: _View, new: _View) -> bool:
    """Whether ``old`` already shows everything ``new`` would (versioned views only)."""
    if old.key != new.key or new.version is None or old.version != new.version:
        return False
    if old.span is None or new.span is None:
        return old.span == new.span
    return old.span[0] <= new.span[0] and old.span[1] >= new.span[1]


def _supersedes(new: _View, old: _View) -> bool:
    if new.key != old.key:
        return False
    if new.version is None:
        return True
    return new.version != old.version or _covers(new, old)

# Maps the arguments of a foreign tool name to (our tool name, our arguments).
ToolAlias = Callable[[dict[str, Any]], tuple[str, dict[str, Any]]]


class Agent:
    def __init__(
        self,
        *,
        role: str,
        model: str,
        system_prompt: str,
        tools: list[Tool],
        llm: SupportsComplete,
        max_steps: int = 25,
        max_tokens: int = 60_000,
        max_output_tokens: int = 1024,
        tool_choice: str | None = "auto",
        keep_recent_tool_results: int = 3,
        keep_recent_views: int = 6,
        max_tool_output_chars: int = 8_000,
        verify_finish: Callable[[], str | None] | None = None,
        verify_give_up: Callable[[], str | None] | None = None,
        submit: SubmitSpec | None = None,
        aliases: dict[str, ToolAlias] | None = None,
        alias_prefixes: Sequence[str] = (),
        fallback_models: Sequence[str] = (),
        nudge: Callable[[int], str | None] | None = None,
        repeat_hint: RepeatHint | None = None,
        on_event: EventCallback | None = None,
    ) -> None:
        """``verify_finish`` checks a claimed success independently of the model:
        it returns None to accept, or a reason that is fed back to the model.

        ``verify_give_up`` does the same for a finish with success=false, e.g.
        to refuse giving up before trying anything.

        ``aliases`` map tool names some models were trained on (e.g. gpt-oss's
        ``repo_browser.*``) to our tools. A name ``<prefix><tool>`` with a
        prefix in ``alias_prefixes`` (e.g. ``repo_browser.list_dir``) maps to
        ``<tool>`` when that is one of ours.

        ``fallback_models`` are used in order once the current model hits a
        per-day limit, or the provider rejected ``MAX_BAD_REQUESTS_PER_MODEL``
        requests to it in a row (HTTP 400); the conversation carries over.

        A tool call identical to the last ``REPEAT_CALL_LIMIT - 1`` ones (same
        name and arguments, same result, no file changed since) is not run;
        the agent is told to do something different, with
        ``repeat_hint(name, arguments)`` when that returns a hint.

        With ``submit``, success is reported only through the submit tool;
        ``finish`` remains available for giving up (success=false).

        ``nudge(step)`` is called before each LLM call; a returned string is
        added to the conversation as a note for that turn.

        The latest result of up to ``keep_recent_views`` views (see
        ``ToolOutput.view_key``) is kept in full even when older than the
        last ``keep_recent_tool_results`` tool results."""
        names = [t.name for t in tools]
        reserved = {FINISH_TOOL} | ({submit.name} if submit else set())
        if reserved & set(names):
            raise ValueError(f"reserved tool names: {sorted(reserved & set(names))}")
        if len(set(names)) != len(names):
            raise ValueError(f"duplicate tool names: {names}")
        self.role = role
        self.model = model
        self.system_prompt = system_prompt
        self.tools = {t.name: t for t in tools}
        self.llm = llm
        self.max_steps = max_steps
        self.max_tokens = max_tokens
        self.max_output_tokens = max_output_tokens
        self.tool_choice = tool_choice
        self.keep_recent_tool_results = keep_recent_tool_results
        self.keep_recent_views = keep_recent_views
        self.max_tool_output_chars = max_tool_output_chars
        self.verify_finish = verify_finish
        self.verify_give_up = verify_give_up
        self.aliases = aliases or {}
        self.alias_prefixes = tuple(alias_prefixes)
        self.fallback_models = [m for m in dict.fromkeys(fallback_models) if m != model]
        # Models called during the latest run, and ``partial_result(summary, reason)``:
        # a result for that run so far, for when it is cancelled.
        self.models_used: list[str] = []
        self.partial_result: Callable[[str, StopReason], AgentResult] | None = None
        self.submit = submit
        self.nudge = nudge
        self.repeat_hint = repeat_hint
        self.on_event = on_event
        self._schemas = [t.schema() for t in tools] + ([submit.schema()] if submit else []) + [FINISH.schema()]

    async def run(self, task: str) -> AgentResult:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]
        usage = TokenUsage()
        files_changed: list[str] = []
        # Message index -> view, for view results still in full.
        views: dict[int, _View] = {}
        step = 0
        self.model = self.model_chain[0]
        self.models_used = []
        # Models found exhausted (per-day limit) during this run, and models given
        # up on after repeated 400s (model -> why).
        exhausted: dict[str, DailyLimitReached] = {}
        failing: dict[str, str] = {}
        # Exact tool call -> its latest run; and how many tool runs changed files.
        repeats: dict[str, _Repeat] = {}
        edits = 0

        def result(success: bool, summary: str, reason: StopReason, output: BaseModel | None = None) -> AgentResult:
            return AgentResult(
                role=self.role,
                success=success,
                summary=summary,
                files_changed=files_changed,
                steps_used=step,
                tokens_used=usage.total_tokens,
                prompt_tokens=usage.prompt_tokens,
                completion_tokens=usage.completion_tokens,
                stop_reason=reason,
                output=output.model_dump() if output is not None else None,
                models_used=list(self.models_used),
            )

        self.partial_result = lambda summary, reason: result(False, summary, reason)

        def submitted(payload: BaseModel, arguments: dict[str, Any]) -> AgentResult:
            summary = str(getattr(payload, self.submit.summary_field, "") or f"called {self.submit.name}")
            self._emit(step, usage, "finish", tool=self.submit.name, arguments=arguments, summary=_preview(summary))
            return result(True, summary, "finished", payload)

        def invalid_submit(error: str) -> tuple[AgentResult | None, str]:
            """Count a failed submit. Returns the final result once retries run out,
            otherwise the feedback for the model."""
            nonlocal invalid_submits
            invalid_submits += 1
            left = self.submit.max_retries - invalid_submits + 1
            self._emit(step, usage, "note", summary=f"{self.submit.name} rejected: {error}", is_error=True)
            if left <= 0:
                summary = f"{self.submit.name} failed validation {invalid_submits} times; last error: {error}"
                return result(False, summary, "invalid_output"), ""
            return None, (
                f"ERROR: {self.submit.name} arguments are invalid: {error}. "
                f"Fix them and call {self.submit.name} again ({left} retries left)."
            )

        invalid_submits = 0
        text_only_streak = 0
        # Consecutive 400s on the current model, and those without a failed_generation.
        bad_requests = 0
        blank_bad_requests = 0
        while step < self.max_steps:
            if usage.total_tokens >= self.max_tokens:
                return result(
                    False, f"Stopped: token budget of {self.max_tokens} exhausted.", "max_tokens"
                )
            step += 1
            note = self.nudge(step) if self.nudge is not None else None
            if note:
                self._emit(step, usage, "note", summary=note)
                messages.append({"role": "user", "content": note})
            self._compact(messages, views)
            try:
                response = await self._complete(messages, step, usage, exhausted, failing)
            except BadRequest as exc:
                code = exc.code or "no error code"
                bad_requests += 1
                blank_bad_requests = blank_bad_requests + 1 if exc.failed_generation is None else 0
                if bad_requests >= MAX_BAD_REQUESTS_PER_MODEL:
                    why = f"rejected {bad_requests} requests in a row (400, {code})"
                    following = self._next_model(exhausted, {**failing, self.model: why})
                    if following is not None:
                        failing[self.model] = why
                        self._switch_model(step, usage, following, "bad_requests",
                                           f"model kept failing on {self.model} ({why}), switching to {following}")
                        bad_requests = blank_bad_requests = 0
                        continue
                if exc.failed_generation is None:
                    if blank_bad_requests > MAX_BAD_REQUEST_RETRIES:
                        failing[self.model] = f"rejected {blank_bad_requests} requests in a row (400, {code})"
                        if len(self.model_chain) == 1:
                            summary = (
                                f"LLM call failed: the provider rejected the request {blank_bad_requests} times "
                                f"in a row (400, {code}): {exc}"
                            )
                        else:
                            summary = f"LLM call failed: {AllModelsExhausted(self.role, list(exhausted.values()), failing)}"
                        self._emit(step, usage, "note", summary=summary, is_error=True)
                        return result(False, summary, "error")
                    self._emit(step, usage, "note", is_error=True, summary=(
                        f"provider rejected the request (400, {code}); "
                        f"retry {blank_bad_requests}/{MAX_BAD_REQUEST_RETRIES}"
                    ))
                    if exc.code == "tool_use_failed":
                        unknown = re.search(r"call tool '([^']+)'", str(exc))
                        if unknown:
                            feedback = self._unknown_tool_message(unknown.group(1))
                        else:
                            feedback = "Your last tool call was malformed. Call one tool with valid JSON arguments."
                        messages.append({"role": "user", "content": feedback})
                    continue
                # What the model actually wrote is handled like any reply: a tool
                # call written as JSON text is run, prose follows the plain-text rules.
                self._emit(step, usage, "note", summary=f"provider could not parse the reply ({code}); using its text")
                response = LLMResponse(model=self.model, content=exc.failed_generation)
            except AllModelsExhausted as exc:
                self._emit(step, usage, "note", summary=str(exc), is_error=True)
                return result(False, str(exc), "error" if exc.failing else "daily_limit")
            except Exception as exc:
                self._emit(step, usage, "note", summary=f"LLM call failed: {exc}", is_error=True)
                return result(False, f"LLM call failed: {type(exc).__name__}: {exc}", "error")
            else:
                bad_requests = blank_bad_requests = 0

            text_call_error = None
            if not response.tool_calls:
                looks_like_call = _looks_like_text_tool_call(response.content)
                if looks_like_call and response.finish_reason == "length":
                    # Repairing cut-off JSON would run the call with truncated arguments.
                    text_call_error = (
                        "ERROR: your reply was cut off at the output token limit, so the tool call you wrote as "
                        "text was not run. Call the tool natively, and keep content short (edit_file or "
                        "insert_lines instead of rewriting a large file)."
                    )
                elif (text_call := self._tool_call_from_text(response.content, step)) is not None:
                    self._emit(step, usage, "note", summary=f"tool call written as text; running {text_call.name}")
                    response = response.model_copy(update={"content": None, "tool_calls": [text_call]})
                elif looks_like_call:
                    text_call_error = (
                        "ERROR: your tool call written as text could not be parsed as JSON, so it was not run. "
                        "Call the tool natively (as a function call), not as text."
                    )
            if response.tool_calls:
                response = response.model_copy(update={"tool_calls": [self._resolve_alias(c, step, usage) for c in response.tool_calls]})

            usage = usage + response.usage
            self._emit(
                step, usage, "llm_call",
                prompt_tokens=response.usage.prompt_tokens, completion_tokens=response.usage.completion_tokens,
            )
            messages.append(response.to_message())
            text = (response.content or "").strip()
            if text_call_error is not None:
                self._emit(step, usage, "note", summary=text_call_error.removeprefix("ERROR: "), is_error=True)
                messages.append({"role": "user", "content": text_call_error})
                continue

            if not response.tool_calls:
                data = _json_from_text(text)
                # JSON (finish or submit arguments as text) never counts as a prose answer.
                if data is None:
                    text_only_streak += 1
                if (
                    self.submit is not None
                    and data is not None
                    and not _looks_like_finish(data)
                    and set(data) & set(self.submit.schema_model.model_fields)
                ):
                    # The submit arguments written as plain JSON text.
                    payload, error = self._validate_submit(data)
                    if payload is not None:
                        return submitted(payload, data)
                    final, feedback = invalid_submit(error)
                    if final is not None:
                        return final
                    messages.append({"role": "user", "content": feedback})
                    continue
                finish = _finish_from_args(data) if data is not None else None
                if finish is not None:
                    rejection = self._reject_finish(finish)
                    if rejection is None:
                        self._emit(step, usage, "finish", tool=FINISH_TOOL, summary=finish.summary, is_error=not finish.success)
                        return result(finish.success, finish.summary, "finished")
                    self._emit(step, usage, "note", summary=f"finish rejected: {rejection}", is_error=True)
                    messages.append({"role": "user", "content": f"finish rejected: {rejection}"})
                    continue
                if text and text_only_streak >= 2 and self.submit is None:
                    # Some models (e.g. gpt-oss) end with a prose answer instead of
                    # calling finish. Accept it, but success comes from the verifier.
                    success = self.verify_finish is not None and self.verify_finish() is None
                    rejection = None if success or self.verify_give_up is None else self.verify_give_up()
                    if rejection is None:
                        self._emit(step, usage, "finish", tool=FINISH_TOOL, summary=_preview(text), is_error=not success)
                        return result(success, text, "finished")
                    text_only_streak = 0
                    self._emit(step, usage, "note", summary=f"give-up rejected: {rejection}", is_error=True)
                    messages.append({"role": "user", "content": rejection})
                    continue
                if text:
                    self._emit(step, usage, "thought", summary=_preview(text))
                done_tool = self.submit.name if self.submit else FINISH_TOOL
                messages.append({"role": "user", "content": f"If the task is done, call `{done_tool}`. Otherwise call the next tool."})
                continue

            text_only_streak = 0
            if text:
                self._emit(step, usage, "thought", summary=_preview(text))
            for call in response.tool_calls:
                if self.submit is not None and call.name == self.submit.name:
                    if call.parse_error:
                        payload, error = None, f"arguments were not valid JSON: {call.parse_error}"
                    else:
                        payload, error = self._validate_submit(call.arguments)
                    if payload is not None:
                        return submitted(payload, call.arguments)
                    final, feedback = invalid_submit(error)
                    if final is not None:
                        return final
                    messages.append(_tool_message(call.id, feedback))
                    continue
                if call.name == FINISH_TOOL and call.parse_error is None:
                    try:
                        finish = FinishArgs.model_validate(call.arguments)
                    except ValidationError as exc:
                        messages.append(_tool_message(call.id, f"ERROR: {_format_validation(exc)}"))
                        continue
                    rejection = self._reject_finish(finish)
                    if rejection is not None:
                        self._emit(step, usage, "note", summary=f"finish rejected: {rejection}", is_error=True)
                        messages.append(_tool_message(call.id, f"ERROR: finish rejected: {rejection}"))
                        continue
                    self._emit(step, usage, "finish", tool=FINISH_TOOL, arguments=call.arguments, summary=finish.summary, is_error=not finish.success)
                    return result(finish.success, finish.summary, "finished")

                self._emit(step, usage, "tool_called", tool=call.name, arguments=call.arguments)
                key = _call_key(call)
                seen = repeats.get(key)
                if seen is not None and seen.edits == edits and seen.count >= REPEAT_CALL_LIMIT - 1:
                    # Nothing changed since the identical calls before, so neither would the result.
                    times = seen.count + 1
                    repeats[key] = seen._replace(count=times)
                    hint = (self.repeat_hint(call.name, call.arguments) if self.repeat_hint else None) or DEFAULT_REPEAT_HINT
                    messages.append(_tool_message(call.id, (
                        f"You've made this exact call {times} times and the result hasn't changed. "
                        f"Do something different: {hint}"
                    )))
                    self._emit(step, usage, "tool_result", tool=call.name, arguments=call.arguments, is_error=True,
                               summary=f"not run: the same call {times} times with an unchanged result")
                    continue
                output = await self._execute(call.name, call.arguments, call.parse_error)
                if output.files_changed:
                    edits += 1
                for path in output.files_changed:
                    if path not in files_changed:
                        files_changed.append(path)
                same = seen is not None and seen.content == output.content and seen.edits == edits
                repeats[key] = _Repeat(seen.count + 1 if same else 1, output.content, edits)
                content = output.content
                summary = output.summary or _preview(content)
                if output.view_key is not None:
                    view = _View(output.view_key, step, output.view_version, output.view_span)
                    earlier = _earlier_view(messages, views, view, content)
                    if earlier is not None:
                        content = _unchanged_note(earlier, view)
                        summary += " (unchanged, short note)"
                    else:
                        views[len(messages)] = view
                messages.append(_tool_message(call.id, content))
                self._emit(
                    step,
                    usage,
                    "tool_result",
                    tool=call.name,
                    arguments=call.arguments,
                    summary=summary,
                    is_error=output.is_error,
                )
                if output.finish_summary is not None:
                    self._emit(step, usage, "note", summary=output.finish_summary)
                    self._emit(step, usage, "finish", tool="auto-finish", summary=output.finish_summary)
                    return result(True, output.finish_summary, "finished")

        return result(False, f"Stopped: reached the limit of {self.max_steps} steps.", "max_steps")

    @property
    def model_chain(self) -> list[str]:
        """The models this agent may use, in order: its own, then the fallbacks."""
        first = self.models_used[0] if self.models_used else self.model
        return [first, *[m for m in self.fallback_models if m != first]]

    def _next_model(self, exhausted: dict[str, DailyLimitReached], failing: dict[str, str]) -> str | None:
        """The first model in the chain not exhausted or given up on, if any."""
        return next((m for m in self.model_chain if m not in exhausted and m not in failing), None)

    def _switch_model(self, step: int, usage: TokenUsage, to: str, reason: str, summary: str) -> None:
        self._emit(step, usage, "model_switch", summary=summary, is_error=True,
                   arguments={"from": self.model, "to": to, "reason": reason})
        self.model = to

    async def _complete(
        self,
        messages: list[dict[str, Any]],
        step: int,
        usage: TokenUsage,
        exhausted: dict[str, DailyLimitReached],
        failing: dict[str, str],
    ) -> LLMResponse:
        """One LLM call. On a per-day limit, switch to the next usable model and
        call again with the same conversation; ``AllModelsExhausted`` once none is left."""
        while True:
            if not self.models_used or self.models_used[-1] != self.model:
                self.models_used.append(self.model)
            try:
                return await self.llm.complete(
                    self.model,
                    messages,
                    self._schemas,
                    tool_choice=self.tool_choice,
                    max_tokens=self.max_output_tokens,
                )
            except DailyLimitReached as exc:
                exhausted[self.model] = exc
                following = self._next_model(exhausted, failing)
                if following is None:
                    limits = [exhausted[m] for m in self.model_chain if m in exhausted]
                    raise AllModelsExhausted(self.role, limits, failing) from exc
                self._switch_model(step, usage, following, "daily_limit",
                                   f"daily limit reached on {self.model}, switching to {following}")

    def _reject_finish(self, finish: FinishArgs) -> str | None:
        """Why a claimed success is not accepted, or None to accept the finish."""
        if finish.success and self.submit is not None:
            return f"report your result by calling {self.submit.name}; use {FINISH_TOOL} only with success=false to give up"
        if finish.success and self.verify_finish is not None:
            return self.verify_finish()
        if not finish.success and self.verify_give_up is not None:
            return self.verify_give_up()
        return None

    def _known_tools(self) -> list[str]:
        return [*self.tools] + ([self.submit.name] if self.submit else []) + [FINISH_TOOL]

    def _is_tool_name(self, name: str) -> bool:
        """One of our tools, or a foreign name that maps to one."""
        return name in self._known_tools() or self._alias_target(name, {}) is not None

    def _unknown_tool_message(self, name: str) -> str:
        mapped = self._alias_target(name, {})
        hint = f" Call {mapped[0]} instead." if mapped else ""
        return (
            f"ERROR: unknown tool '{name}'.{hint} The only tools you can call are: "
            f"{', '.join(self._known_tools())}. Call one of them."
        )

    def _resolve_alias(self, call: ToolCall, step: int, usage: TokenUsage) -> ToolCall:
        """Map a foreign tool name (e.g. repo_browser.open_file) to our tool."""
        if call.name in self._known_tools() or call.parse_error:
            return call
        mapped = self._alias_target(call.name, call.arguments)
        if mapped is None:
            return call
        target, arguments = mapped
        self._emit(step, usage, "note", summary=f"mapped {call.name} -> {target}")
        return call.model_copy(update={"name": target, "arguments": arguments})

    def _alias_target(self, name: str, arguments: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
        """(our tool, its arguments) for a foreign tool name, or None."""
        alias = self.aliases.get(name)
        if alias is not None:
            target, mapped = alias(arguments)
            return (target, mapped) if target in self.tools else None
        for prefix in self.alias_prefixes:
            tool = name.removeprefix(prefix)
            if name.startswith(prefix) and tool in self._known_tools():
                return tool, arguments
        return None

    def _validate_submit(self, arguments: dict[str, Any]) -> tuple[BaseModel | None, str]:
        try:
            return self.submit.schema_model.model_validate(arguments, context=self.submit.context), ""
        except ValidationError as exc:
            return None, _format_validation(exc)

    def _tool_call_from_text(self, text: str | None, step: int) -> ToolCall | None:
        """A tool call the model wrote as JSON text ({"name": ..., "arguments": ...}),
        whether or not the tool exists; unknown names get an error like any call.

        "type", "tool" and "function" are accepted in place of "name", but only
        when the value is a known tool name or alias (other JSON has such keys too)."""
        data = _json_from_text(text or "")
        if data is None:
            return None
        name_keys = [key for key in _TOOL_NAME_KEYS if key in data]
        if len(name_keys) != 1 or not set(data) - {name_keys[0]} <= {"arguments", "parameters"}:
            return None
        name = data[name_keys[0]]
        if name_keys[0] != "name" and not (isinstance(name, str) and self._is_tool_name(name)):
            return None
        arguments = data.get("arguments", data.get("parameters", {}))
        if isinstance(arguments, str):
            arguments = _load_object(arguments) if arguments.strip() != "{}" else {}
        # json-repair turns almost anything into an object; accept only a usable call.
        if not isinstance(name, str) or not name.strip() or not isinstance(arguments, dict):
            return None
        return ToolCall(id=f"text_call_{step}", name=name, arguments=arguments)

    async def _execute(self, name: str, arguments: dict[str, Any], parse_error: str | None) -> ToolOutput:
        tool = self.tools.get(name)
        if tool is None:
            return ToolOutput(content=self._unknown_tool_message(name), is_error=True)
        if parse_error:
            return ToolOutput(content=f"ERROR: arguments were not valid JSON: {parse_error}", is_error=True)
        try:
            output = await tool.invoke(arguments)
        except ValidationError as exc:
            return ToolOutput(content=f"ERROR: invalid arguments: {_format_validation(exc)}", is_error=True)
        except Exception as exc:
            return ToolOutput(content=f"ERROR: {type(exc).__name__}: {exc}", is_error=True)
        if len(output.content) > self.max_tool_output_chars:
            cut = len(output.content) - self.max_tool_output_chars
            output = output.model_copy(
                update={"content": output.content[: self.max_tool_output_chars] + f"\n[… {cut} chars truncated]"}
            )
        return output

    def _compact(self, messages: list[dict[str, Any]], views: dict[int, _View] | None = None) -> None:
        """Shrink old tool results and old tool-call arguments in place.

        Every request resends the whole history, so on a tokens-per-minute
        budget, stale file dumps and test logs are the main cost. The latest
        result of each recent view (e.g. the last read of a file) is kept in
        full so the model does not have to read it again; older results for
        the same view are replaced with a stub.
        """
        views = views if views is not None else {}
        for index in sorted(views):
            old = views[index]
            if any(later > index and _supersedes(view, old) for later, view in views.items()):
                messages[index] = {**messages[index], "content": f"[superseded by a later result for {old.key}]"}
                del views[index]
        pinned = set(sorted(views)[-self.keep_recent_views:]) if self.keep_recent_views > 0 else set()

        tool_indexes = [i for i, m in enumerate(messages) if m["role"] == "tool"]
        keep = self.keep_recent_tool_results
        if len(tool_indexes) <= keep:
            return
        cutoff = tool_indexes[-keep] if keep > 0 else len(messages)
        for i in range(cutoff):
            message = messages[i]
            if message["role"] == "tool":
                if i in pinned:
                    continue
                content = message["content"]
                if len(content) > ELIDE_KEEP_CHARS + len(ELIDED_MARK) and not content.endswith(ELIDED_MARK):
                    messages[i] = {**message, "content": content[:ELIDE_KEEP_CHARS] + ELIDED_MARK}
                    views.pop(i, None)
            elif message["role"] == "assistant" and message.get("tool_calls"):
                messages[i] = {**message, "tool_calls": [_shrink_call(c) for c in message["tool_calls"]]}

    def _emit(self, step: int, usage: TokenUsage, kind: str, **fields: Any) -> None:
        if self.on_event:
            self.on_event(AgentEvent(role=self.role, step=step, kind=kind, tokens_used=usage.total_tokens, **fields))


def _call_key(call: ToolCall) -> str:
    return json.dumps([call.name, call.arguments, call.parse_error], sort_keys=True, default=str)


def _tool_message(call_id: str, content: str) -> dict[str, Any]:
    return {"role": "tool", "tool_call_id": call_id, "content": content}


def _shrink_call(call: dict[str, Any], limit: int = 200) -> dict[str, Any]:
    raw = call["function"]["arguments"]
    if len(raw) <= limit:
        return call
    try:
        args = json.loads(raw)
    except json.JSONDecodeError:
        return call
    shrunk = {
        k: (v[:limit] + "…[elided]" if isinstance(v, str) and len(v) > limit else v)
        for k, v in args.items()
    }
    return {**call, "function": {**call["function"], "arguments": json.dumps(shrunk)}}


def _earlier_view(messages: list[dict[str, Any]], views: dict[int, _View], view: _View, content: str) -> _View | None:
    """The latest view still in full that already shows what ``view`` would."""
    for index in sorted(views, reverse=True):
        earlier = views[index]
        if earlier.key != view.key:
            continue
        if view.version is None and messages[index]["content"] == content:
            return earlier
        if _covers(earlier, view):
            return earlier
    return None


def _unchanged_note(earlier: _View, view: _View) -> str:
    if earlier.span and view.span:
        return (
            f"[{view.key}, lines {view.span[0]}-{view.span[1]}: unchanged since your read at step {earlier.step} "
            f"(lines {earlier.span[0]}-{earlier.span[1]}), which is still in your context above; not repeated]"
        )
    return (
        f"[unchanged since your identical call at step {earlier.step}; "
        "that result is still in your context above, so it is not repeated]"
    )


# Keys a tool call written as JSON text may use for the tool name.
_TOOL_NAME_KEYS = ("name", "type", "tool", "function")
_TEXT_TOOL_CALL_RE = re.compile(r'^\s*(?:```(?:json)?\s*)?\{\s*"name"\s*:')


def _looks_like_text_tool_call(text: str | None) -> bool:
    return bool(text and _TEXT_TOOL_CALL_RE.match(text))


def _json_from_text(text: str) -> dict[str, Any] | None:
    """A JSON object written as plain text (e.g. a tool call) instead of a tool call.

    Tries strict JSON (raw newlines in strings allowed), then json-repair, then
    the outermost {...} block of the text.
    """
    candidate = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    if candidate.startswith("{"):
        data = _load_object(candidate)
        if data is not None:
            return data
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end and text[start:end + 1] != candidate:
        return _load_object(text[start:end + 1])
    return None


def _load_object(text: str) -> dict[str, Any] | None:
    try:
        data = json.loads(text, strict=False)
    except json.JSONDecodeError:
        try:
            data = json_repair.loads(text)
        except Exception:
            return None
    return data if isinstance(data, dict) and data else None


def _looks_like_finish(data: dict[str, Any]) -> bool:
    return bool(data) and set(data) <= set(FinishArgs.model_fields)


def _finish_from_args(data: dict[str, Any]) -> FinishArgs | None:
    """Recognise finish arguments written as plain JSON text instead of a tool call."""
    try:
        return FinishArgs.model_validate(data)
    except ValidationError:
        return None


def _preview(text: str, limit: int = 160) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 3] + "..."


def _format_validation(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in err['loc']) or 'arguments'}: {err['msg']}" for err in exc.errors()
    )


def _json_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Tool-parameter schema for ``model``: titles stripped and nested models
    inlined, since some providers handle ``$ref`` poorly."""
    schema = model.model_json_schema()
    defs = schema.pop("$defs", {})
    return _strip_titles(_inline_refs(schema, defs))


def _inline_refs(schema: Any, defs: dict[str, Any]) -> Any:
    if isinstance(schema, dict):
        ref = schema.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            return _inline_refs(defs[ref.removeprefix("#/$defs/")], defs)
        return {key: _inline_refs(value, defs) for key, value in schema.items()}
    if isinstance(schema, list):
        return [_inline_refs(item, defs) for item in schema]
    return schema


def _strip_titles(schema: Any, in_properties: bool = False) -> Any:
    """Drop pydantic's auto-generated "title" keys; they cost tokens on every call."""
    if isinstance(schema, dict):
        return {
            key: _strip_titles(value, in_properties=(key == "properties" and not in_properties))
            for key, value in schema.items()
            if in_properties or not (key == "title" and isinstance(value, str))
        }
    if isinstance(schema, list):
        return [_strip_titles(item) for item in schema]
    return schema
