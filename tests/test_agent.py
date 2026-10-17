"""Agent loop tests with a scripted (mocked) LLM."""

import asyncio
import shutil
from pathlib import Path

from pydantic import BaseModel

from patchwork.agents.base import ELIDED_MARK, Agent, AgentEvent, Tool, ToolOutput
from patchwork.agents.coder import build_coder, build_task
from patchwork.config import Settings
from patchwork.llm import LLMResponse, MalformedToolCall, ToolCall

from conftest import TOY_CALCULATOR
from scripted import ScriptedLLM, finish, reply


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


def test_finish_written_as_json_text_is_accepted():
    llm = ScriptedLLM([reply(content='```json\n{"success": true, "summary": "fixed it"}\n```')])
    result = run(make_agent(llm))
    assert (result.success, result.summary, result.stop_reason) == (True, "fixed it", "finished")


def test_repeated_prose_is_taken_as_final_answer_and_verified():
    for verified, expected in [(True, True), (False, False)]:
        llm = ScriptedLLM([reply(content="All tests pass now."), reply(content="Done: fixed subtract.")])
        result = run(make_agent(llm, verify_finish=lambda: None if verified else "tests not run"))
        assert result.stop_reason == "finished"
        assert result.summary == "Done: fixed subtract."
        assert result.success is expected


def test_verifier_rejects_claimed_success_and_agent_continues():
    gate = {"ok": False}

    def fix(args: EchoArgs) -> str:
        gate["ok"] = True
        return "fixed"

    tools = [Tool(name="fix", description="Fix.", args_model=EchoArgs, handler=fix)]
    llm = ScriptedLLM([finish(), reply(("fix", {"text": "x"})), finish()])
    result = run(make_agent(llm, tools=tools, verify_finish=lambda: None if gate["ok"] else "not fixed yet"))
    assert result.success
    assert result.steps_used == 3
    assert llm.requests[1][-1]["content"] == "ERROR: finish rejected: not fixed yet"


def test_verifier_does_not_block_reporting_failure():
    llm = ScriptedLLM([finish(success=False, summary="stuck")])
    result = run(make_agent(llm, verify_finish=lambda: "never verified"))
    assert (result.success, result.summary) == (False, "stuck")


def test_rejected_generation_is_used_as_the_reply():
    exc = MalformedToolCall("tool_use_failed", failed_generation='{"success": true, "summary": "done via text"}')
    llm = ScriptedLLM([exc])
    result = run(make_agent(llm))
    assert (result.success, result.summary) == (True, "done via text")


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
        # Only a subset has passed so far, so a claimed success is rejected...
        finish(summary="too early"),
        reply(("edit_file", {"path": "calculator/stats.py", "old": "len(values) - 1", "new": "len(values)"})),
        reply(("run_tests", {})),
        # ...and accepted once the full suite passes.
        finish(summary="fixed subtract, divide and mean"),
    ])
    settings = Settings(_env_file=None, max_steps_per_agent=10)
    agent = build_coder(repo=repo, settings=settings, llm=llm)
    result = asyncio.run(agent.run(build_task(repo, "subtract is wrong")))

    assert result.success
    assert result.summary == "fixed subtract, divide and mean"
    assert result.files_changed == ["calculator/ops.py", "calculator/stats.py"]
    tool_results = [m["content"] for m in llm.requests[-1] if m["role"] == "tool"]
    assert tool_results[0] == "calculator/ops.py:9: def subtract(a, b):"
    assert "return b - a" in tool_results[1]
    assert tool_results[2] == "edited calculator/ops.py at line 11"
    assert tool_results[3] == "edited calculator/ops.py at line 23"
    assert tool_results[4].startswith("PASSED: 1 passed")
    assert tool_results[5].startswith("PASSED: 5 passed")
    assert tool_results[6].startswith("ERROR: finish rejected: the full test suite has not passed")
    assert tool_results[8].startswith("PASSED: 8 passed")
    source = (repo / "calculator" / "ops.py").read_text()
    assert "return a - b" in source and "return a / b" in source
