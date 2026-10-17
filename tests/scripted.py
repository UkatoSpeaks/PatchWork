"""A scripted (mocked) LLM and helpers for building its responses."""

from __future__ import annotations

import copy
from typing import Any

from patchwork.llm import LLMResponse, TokenUsage, ToolCall


class ScriptedLLM:
    """Returns pre-baked responses in order and records what it was sent.

    Pass a list for a single agent, or a dict of lists keyed by model name to
    script several agents (give each role its own model in Settings).
    """

    def __init__(self, responses: list[LLMResponse | Exception] | dict[str, list[LLMResponse | Exception]]):
        self.scripts = {k: list(v) for k, v in responses.items()} if isinstance(responses, dict) else None
        self.responses = list(responses) if self.scripts is None else []
        self.requests: list[list[dict[str, Any]]] = []
        self.tools_sent: list[list[dict[str, Any]]] = []
        self.requests_by_model: dict[str, list[list[dict[str, Any]]]] = {}

    async def complete(self, model, messages, tools=None, *, tool_choice=None, max_tokens=None):
        snapshot = copy.deepcopy(messages)
        self.requests.append(snapshot)
        self.requests_by_model.setdefault(model, []).append(snapshot)
        self.tools_sent.append(tools)
        queue = self.responses if self.scripts is None else self.scripts[model]
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def requests_for(self, model: str) -> list[list[dict[str, Any]]]:
        return self.requests_by_model.get(model, [])


def reply(*calls: tuple[str, dict[str, Any]], content: str | None = None, prompt=100, completion=10) -> LLMResponse:
    return LLMResponse(
        model="fake",
        content=content,
        tool_calls=[ToolCall(id=f"call_{i}", name=name, arguments=args) for i, (name, args) in enumerate(calls)],
        usage=TokenUsage(prompt_tokens=prompt, completion_tokens=completion),
    )


def finish(success=True, summary="done", **kwargs) -> LLMResponse:
    return reply(("finish", {"success": success, "summary": summary}), **kwargs)


def tool_results(messages: list[dict[str, Any]]) -> list[str]:
    return [m["content"] for m in messages if m["role"] == "tool"]
