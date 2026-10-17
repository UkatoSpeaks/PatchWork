"""Agent loop tests with a scripted (mocked) LLM."""

import asyncio
import copy
import shutil
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from patchwork.agents.base import ELIDED_MARK, Agent, AgentEvent, Tool, ToolOutput
from patchwork.agents.coder import build_coder, build_task
from patchwork.config import Settings
from patchwork.llm import LLMResponse, MalformedToolCall, TokenUsage, ToolCall

from conftest import TOY_CALCULATOR


class ScriptedLLM:
    """Returns pre-baked responses in order and records what it was sent."""

    def __init__(self, responses: list[LLMResponse | Exception]):
        self.responses = list(responses)
        self.requests: list[list[dict[str, Any]]] = []
        self.tools_sent: list[list[dict[str, Any]]] = []

    async def complete(self, model, messages, tools=None, *, tool_choice=None, max_tokens=None):
        self.requests.append(copy.deepcopy(messages))
        self.tools_sent.append(tools)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def reply(*calls: tuple[str, dict[str, Any]], content: str | None = None, prompt=100, completion=10) -> LLMResponse:
    return LLMResponse(
        model="fake",
        content=content,
        tool_calls=[ToolCall(id=f"call_{i}", name=name, arguments=args) for i, (name, args) in enumerate(calls)],
        usage=TokenUsage(prompt_tokens=prompt, completion_tokens=completion),
    )


def finish(success=True, summary="done") -> LLMResponse:
    return reply(("finish", {"success": success, "summary": summary}))


class EchoArgs(BaseModel):
    text: str


def make_agent(llm, tools=None, **kwargs) -> Agent:
    def echo(args: EchoArgs) -> ToolOutput:
        return ToolOutput(content=f"echo: {args.text}", files_changed=["echoed.txt"])

    def boom(args: EchoArgs) -> str:
        raise RuntimeError("kaboom")

    default_tools = [
        Tool(name="echo", description="Echo text.", args_model=EchoArgs, handler=echo),
        Tool(name="boom", description="Always fails.", args_model=EchoArgs, handler=boom),
    ]
    return Agent(role="test", model="fake", system_prompt="sys", tools=tools or default_tools, llm=llm, **kwargs)


def run(agent: Agent, task: str = "do it"):
    return asyncio.run(agent.run(task))


def test_executes_tools_feeds_results_back_and_finishes():
    llm = ScriptedLLM([reply(("echo", {"text": "hi"})), finish(summary="all good")])
    events: list[AgentEvent] = []
    result = run(make_agent(llm, on_event=events.append))

    assert result.success is True
    assert result.stop_reason == "finished"
    assert result.summary == "all good"
    assert result.steps_used == 2
    assert result.tokens_used == 220
    assert (result.prompt_tokens, result.completion_tokens) == (200, 20)
    assert result.files_changed == ["echoed.txt"]

    second_request = llm.requests[1]
    assert second_request[-2]["role"] == "assistant"
    assert second_request[-2]["tool_calls"][0]["function"]["name"] == "echo"
    assert second_request[-1] == {"role": "tool", "tool_call_id": "call_0", "content": "echo: hi"}
    assert [e.kind for e in events] == ["tool_call", "finish"]


def test_finish_tool_is_always_offered_without_titles():
    llm = ScriptedLLM([finish()])
    run(make_agent(llm))
    names = [t["function"]["name"] for t in llm.tools_sent[0]]
    assert names == ["echo", "boom", "finish"]
    assert "title" not in str(llm.tools_sent[0])


def test_stops_at_max_steps():
    llm = ScriptedLLM([reply(("echo", {"text": str(i)})) for i in range(3)])
    result = run(make_agent(llm, max_steps=3))
    assert result.success is False
    assert result.stop_reason == "max_steps"
    assert result.steps_used == 3
    assert len(llm.requests) == 3


def test_stops_when_token_budget_exhausted():
    llm = ScriptedLLM([reply(("echo", {"text": "a"}), prompt=600, completion=0)] * 5)
    result = run(make_agent(llm, max_tokens=1000))
    assert result.stop_reason == "max_tokens"
    assert result.success is False
    assert result.steps_used == 2
    assert result.tokens_used == 1200


def test_tool_errors_are_fed_back_not_raised():
    llm = ScriptedLLM([
        reply(("boom", {"text": "x"})),
        reply(("nope", {})),
        reply(("echo", {"wrong": 1})),
        finish(),
    ])
    events: list[AgentEvent] = []
    result = run(make_agent(llm, on_event=events.append))

    assert result.success is True
    tool_results = [m["content"] for m in llm.requests[-1] if m["role"] == "tool"]
    assert tool_results[0] == "ERROR: RuntimeError: kaboom"
    assert tool_results[1].startswith("ERROR: unknown tool 'nope'")
    assert tool_results[2].startswith("ERROR: invalid arguments: text: Field required")
    assert [e.is_error for e in events if e.kind == "tool_call"] == [True, True, True]


def test_unparseable_arguments_are_reported():
    bad = LLMResponse(model="fake", tool_calls=[ToolCall(id="c", name="echo", parse_error="Expecting value")])
    llm = ScriptedLLM([bad, finish()])
    run(make_agent(llm))
    assert llm.requests[1][-1]["content"] == "ERROR: arguments were not valid JSON: Expecting value"


def test_text_only_reply_gets_nudged():
    llm = ScriptedLLM([reply(content="I think the bug is in ops.py"), finish()])
    events: list[AgentEvent] = []
    result = run(make_agent(llm, on_event=events.append))
    assert result.success
    assert llm.requests[1][-1]["role"] == "user"
    assert "finish" in llm.requests[1][-1]["content"]
    assert events[0].kind == "thought"


def test_malformed_tool_call_from_provider_is_retried():
    llm = ScriptedLLM([MalformedToolCall("tool_use_failed"), finish()])
    result = run(make_agent(llm))
    assert result.success
    assert result.steps_used == 2
    assert "malformed" in llm.requests[1][-1]["content"]


def test_llm_failure_ends_run_with_error():
    llm = ScriptedLLM([RuntimeError("network down")])
    result = run(make_agent(llm))
    assert result.success is False
    assert result.stop_reason == "error"
    assert "network down" in result.summary


def test_finish_with_failure():
    llm = ScriptedLLM([finish(success=False, summary="cannot reproduce")])
    result = run(make_agent(llm))
    assert (result.success, result.stop_reason, result.summary) == (False, "finished", "cannot reproduce")


def test_old_tool_results_are_compacted():
    big = "x" * 2000
    llm = ScriptedLLM([reply(("echo", {"text": big})) for _ in range(4)] + [finish()])
    run(make_agent(llm, keep_recent_tool_results=2))

    last = llm.requests[-1]
    tool_contents = [m["content"] for m in last if m["role"] == "tool"]
    assert [c.endswith(ELIDED_MARK) for c in tool_contents] == [True, True, False, False]
    # Old tool-call arguments are shrunk too; recent ones are untouched.
    assistant_args = [m["tool_calls"][0]["function"]["arguments"] for m in last if m.get("tool_calls")]
    assert len(assistant_args[0]) < 400
    assert len(assistant_args[-1]) > 2000


def test_coder_agent_fixes_toy_repo_with_scripted_llm(tmp_path: Path):
    repo = tmp_path / "calculator"
    shutil.copytree(TOY_CALCULATOR, repo, ignore=shutil.ignore_patterns("__pycache__"))
    llm = ScriptedLLM([
        reply(("search_code", {"pattern": "def subtract"})),
        reply(("read_file", {"path": "calculator/ops.py"})),
        # Two tool calls in one response.
        reply(
            ("edit_file", {"path": "calculator/ops.py", "old": "return b - a", "new": "return a - b"}),
            ("edit_file", {"path": "calculator/ops.py", "old": "return a // b", "new": "return a / b"}),
        ),
        reply(("run_tests", {"path": "tests/test_ops.py::test_subtract"})),
        reply(("run_tests", {"path": "tests/test_ops.py"})),
        finish(summary="fixed subtract and divide"),
    ])
    settings = Settings(_env_file=None, max_steps_per_agent=10)
    agent = build_coder(repo=repo, settings=settings, llm=llm)
    result = asyncio.run(agent.run(build_task(repo, "subtract is wrong")))

    assert result.success
    assert result.files_changed == ["calculator/ops.py"]
    tool_results = [m["content"] for m in llm.requests[-1] if m["role"] == "tool"]
    assert tool_results[0] == "calculator/ops.py:9: def subtract(a, b):"
    assert "return b - a" in tool_results[1]
    assert tool_results[2] == "edited calculator/ops.py at line 11"
    assert tool_results[3] == "edited calculator/ops.py at line 23"
    assert tool_results[4].startswith("PASSED: 1 passed")
    assert tool_results[5].startswith("PASSED: 5 passed")
    source = (repo / "calculator" / "ops.py").read_text()
    assert "return a - b" in source and "return a / b" in source
