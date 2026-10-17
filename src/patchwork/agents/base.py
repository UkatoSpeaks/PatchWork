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
from collections.abc import Callable
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from patchwork.llm import LLMResponse, MalformedToolCall, TokenUsage

FINISH_TOOL = "finish"
ELIDE_KEEP_CHARS = 300
ELIDED_MARK = "\n[…older output elided to save tokens; re-run the tool if you need it]"


class ToolOutput(BaseModel):
    content: str
    # One-line description for logs; defaults to the start of ``content``.
    summary: str | None = None
    files_changed: list[str] = Field(default_factory=list)
    is_error: bool = False


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

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": _json_schema(self.schema_model)},
        }


class AgentEvent(BaseModel):
    """Emitted as the agent works, for live logging."""

    role: str
    step: int
    kind: Literal["thought", "tool_call", "finish", "notice"]
    tool: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)
    summary: str = ""
    is_error: bool = False
    tokens_used: int = 0


StopReason = Literal["finished", "max_steps", "max_tokens", "invalid_output", "error"]


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
        max_tool_output_chars: int = 8_000,
        verify_finish: Callable[[], str | None] | None = None,
        submit: SubmitSpec | None = None,
        on_event: EventCallback | None = None,
    ) -> None:
        """``verify_finish`` checks a claimed success independently of the model:
        it returns None to accept, or a reason that is fed back to the model.

        With ``submit``, success is reported only through the submit tool;
        ``finish`` remains available for giving up (success=false)."""
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
        self.max_tool_output_chars = max_tool_output_chars
        self.verify_finish = verify_finish
        self.submit = submit
        self.on_event = on_event
        self._schemas = [t.schema() for t in tools] + ([submit.schema()] if submit else []) + [FINISH.schema()]

    async def run(self, task: str) -> AgentResult:
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]
        usage = TokenUsage()
        files_changed: list[str] = []
        step = 0

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
            )

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
            self._emit(step, usage, "notice", summary=f"{self.submit.name} rejected: {error}", is_error=True)
            if left <= 0:
                summary = f"{self.submit.name} failed validation {invalid_submits} times; last error: {error}"
                return result(False, summary, "invalid_output"), ""
            return None, (
                f"ERROR: {self.submit.name} arguments are invalid: {error}. "
                f"Fix them and call {self.submit.name} again ({left} retries left)."
            )

        invalid_submits = 0
        text_only_streak = 0
        while step < self.max_steps:
            if usage.total_tokens >= self.max_tokens:
                return result(
                    False, f"Stopped: token budget of {self.max_tokens} exhausted.", "max_tokens"
                )
            step += 1
            self._compact(messages)
            try:
                response = await self.llm.complete(
                    self.model,
                    messages,
                    self._schemas,
                    tool_choice=self.tool_choice,
                    max_tokens=self.max_output_tokens,
                )
            except MalformedToolCall as exc:
                if exc.failed_generation is None:
                    self._emit(step, usage, "notice", summary="malformed tool call rejected by provider; retrying", is_error=True)
                    messages.append({"role": "user", "content": "Your last tool call was malformed. Call one tool with valid JSON arguments."})
                    continue
                # Handle what the model actually wrote like any text-only reply.
                response = LLMResponse(model=self.model, content=exc.failed_generation)
            except Exception as exc:
                self._emit(step, usage, "notice", summary=f"LLM call failed: {exc}", is_error=True)
                return result(False, f"LLM call failed: {type(exc).__name__}: {exc}", "error")

            usage = usage + response.usage
            messages.append(response.to_message())
            text = (response.content or "").strip()

            if not response.tool_calls:
                text_only_streak += 1
                data = _json_from_text(text)
                if self.submit is not None and data is not None and not _looks_like_finish(data):
                    # The submit arguments written as plain JSON text.
                    if data.get("name") == self.submit.name:
                        data = data.get("arguments") or data.get("parameters") or {}
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
                    self._emit(step, usage, "notice", summary=f"finish rejected: {rejection}", is_error=True)
                    messages.append({"role": "user", "content": f"finish rejected: {rejection}"})
                    continue
                if text and text_only_streak >= 2 and self.submit is None:
                    # Some models (e.g. gpt-oss) end with a prose answer instead of
                    # calling finish. Accept it, but success comes from the verifier.
                    success = self.verify_finish is not None and self.verify_finish() is None
                    self._emit(step, usage, "finish", tool=FINISH_TOOL, summary=_preview(text), is_error=not success)
                    return result(success, text, "finished")
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
                        self._emit(step, usage, "notice", summary=f"finish rejected: {rejection}", is_error=True)
                        messages.append(_tool_message(call.id, f"ERROR: finish rejected: {rejection}"))
                        continue
                    self._emit(step, usage, "finish", tool=FINISH_TOOL, arguments=call.arguments, summary=finish.summary, is_error=not finish.success)
                    return result(finish.success, finish.summary, "finished")

                output = await self._execute(call.name, call.arguments, call.parse_error)
                for path in output.files_changed:
                    if path not in files_changed:
                        files_changed.append(path)
                messages.append(_tool_message(call.id, output.content))
                self._emit(
                    step,
                    usage,
                    "tool_call",
                    tool=call.name,
                    arguments=call.arguments,
                    summary=output.summary or _preview(output.content),
                    is_error=output.is_error,
                )

        return result(False, f"Stopped: reached the limit of {self.max_steps} steps.", "max_steps")

    def _reject_finish(self, finish: FinishArgs) -> str | None:
        """Why a claimed success is not accepted, or None to accept the finish."""
        if finish.success and self.submit is not None:
            return f"report your result by calling {self.submit.name}; use {FINISH_TOOL} only with success=false to give up"
        if finish.success and self.verify_finish is not None:
            return self.verify_finish()
        return None

    def _validate_submit(self, arguments: dict[str, Any]) -> tuple[BaseModel | None, str]:
        try:
            return self.submit.schema_model.model_validate(arguments), ""
        except ValidationError as exc:
            return None, _format_validation(exc)

    async def _execute(self, name: str, arguments: dict[str, Any], parse_error: str | None) -> ToolOutput:
        tool = self.tools.get(name)
        if tool is None:
            available = ", ".join([*self.tools, FINISH_TOOL])
            return ToolOutput(content=f"ERROR: unknown tool '{name}'. Available: {available}", is_error=True)
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

    def _compact(self, messages: list[dict[str, Any]]) -> None:
        """Shrink old tool results and old tool-call arguments in place.

        Every request resends the whole history, so on a tokens-per-minute
        budget, stale file dumps and test logs are the main cost.
        """
        tool_indexes = [i for i, m in enumerate(messages) if m["role"] == "tool"]
        keep = self.keep_recent_tool_results
        if len(tool_indexes) <= keep:
            return
        cutoff = tool_indexes[-keep] if keep > 0 else len(messages)
        for i in range(cutoff):
            message = messages[i]
            if message["role"] == "tool":
                content = message["content"]
                if len(content) > ELIDE_KEEP_CHARS + len(ELIDED_MARK) and not content.endswith(ELIDED_MARK):
                    messages[i] = {**message, "content": content[:ELIDE_KEEP_CHARS] + ELIDED_MARK}
            elif message["role"] == "assistant" and message.get("tool_calls"):
                messages[i] = {**message, "tool_calls": [_shrink_call(c) for c in message["tool_calls"]]}

    def _emit(self, step: int, usage: TokenUsage, kind: str, **fields: Any) -> None:
        if self.on_event:
            self.on_event(AgentEvent(role=self.role, step=step, kind=kind, tokens_used=usage.total_tokens, **fields))


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


def _json_from_text(text: str) -> dict[str, Any] | None:
    """A JSON object written as plain text (e.g. tool arguments) instead of a tool call."""
    candidate = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    if not candidate.startswith("{"):
        return None
    try:
        data = json.loads(candidate)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _looks_like_finish(data: dict[str, Any]) -> bool:
    return data.get("name") == FINISH_TOOL or (bool(data) and set(data) <= set(FinishArgs.model_fields))


def _finish_from_args(data: dict[str, Any]) -> FinishArgs | None:
    """Recognise finish arguments written as plain JSON text instead of a tool call."""
    if data.get("name") == FINISH_TOOL:
        data = data.get("arguments") or data.get("parameters") or {}
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
