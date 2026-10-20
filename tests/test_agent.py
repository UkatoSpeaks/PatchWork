"""Agent loop tests with a scripted (mocked) LLM."""

import asyncio
import shutil
from pathlib import Path

from pydantic import BaseModel

from patchwork.agents.base import ELIDED_MARK, Agent, AgentEvent, Tool, ToolOutput
from patchwork.agents.coder import build_coder, build_task
from patchwork.config import Settings
from patchwork.llm import BadRequest, DailyLimitReached, LLMResponse, ToolCall

from conftest import TOY_CALCULATOR
from scripted import ScriptedLLM, finish, reply, tool_results


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
    assert [e.kind for e in events] == ["llm_call", "tool_called", "tool_result", "llm_call", "finish"]


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
    assert [e.is_error for e in events if e.kind == "tool_result"] == [True, True, True]


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
    assert [e.kind for e in events][:2] == ["llm_call", "thought"]


def test_finish_written_as_json_text_is_accepted():
    llm = ScriptedLLM([reply(content='```json\n{"success": true, "summary": "fixed it"}\n```')])
    result = run(make_agent(llm))
    assert (result.success, result.summary, result.stop_reason) == (True, "fixed it", "finished")


def test_finish_with_type_key_keeps_the_summary():
    """Seen from gpt-oss: {"type": "finish", "arguments": {...}} instead of "name"."""
    text = '{"type": "finish", "arguments": {"success": true, "summary": "Added slugify with tests."}}'
    result = run(make_agent(ScriptedLLM([reply(content=text)])))
    assert (result.success, result.summary, result.stop_reason) == (True, "Added slugify with tests.", "finished")


def test_tool_and_function_keys_name_a_known_tool():
    for key in ("type", "tool", "function"):
        llm = ScriptedLLM([reply(content=f'{{"{key}": "echo", "arguments": {{"text": "via {key}"}}}}'), finish()])
        result = run(make_agent(llm))
        assert result.success
        assert f"echo: via {key}" in tool_results(llm.requests[1])


def test_name_key_aliases_accept_tool_aliases():
    llm = ScriptedLLM([reply(content='{"tool": "repo_browser.echo", "arguments": {"text": "aliased"}}'), finish()])
    result = run(make_agent(llm, alias_prefixes=("repo_browser.",)))
    assert result.success
    assert "echo: aliased" in tool_results(llm.requests[1])


def test_name_key_aliases_ignore_unknown_tools():
    """{"type": "bogus"} is just JSON, not a call; {"name": "bogus"} is an unknown-tool call."""
    for text in ('{"type": "bogus", "arguments": {"text": "x"}}', '{"tool": "echo2", "parameters": {}}',
                 '{"function": {"name": "echo"}, "arguments": {"text": "x"}}'):
        llm = ScriptedLLM([reply(content=text), finish()])
        result = run(make_agent(llm))
        assert result.success
        follow_up = llm.requests[1][-1]
        assert follow_up["role"] == "user" and "unknown tool" not in follow_up["content"]
        assert tool_results(llm.requests[1]) == []
    llm = ScriptedLLM([reply(content='{"name": "bogus", "arguments": {}}'), finish()])
    run(make_agent(llm))
    assert "unknown tool 'bogus'" in tool_results(llm.requests[1])[0]


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
    exc = BadRequest("tool_use_failed", code="tool_use_failed", failed_generation='{"success": true, "summary": "done via text"}')
    llm = ScriptedLLM([exc])
    result = run(make_agent(llm))
    assert (result.success, result.summary) == (True, "done via text")


def test_malformed_tool_call_from_provider_is_retried():
    llm = ScriptedLLM([BadRequest("tool_use_failed", code="tool_use_failed"), finish()])
    result = run(make_agent(llm))
    assert result.success
    assert result.steps_used == 2
    assert "malformed" in llm.requests[1][-1]["content"]


def events_of(sink):
    return [e.summary for e in sink if e.kind == "note"]


def test_parse_failure_with_prose_follows_the_plain_text_rules():
    """Groq output_parse_failed: the failed_generation is a thought, not a crash."""
    notes: list[AgentEvent] = []
    exc = BadRequest("parse failed", code="output_parse_failed",
                     failed_generation="We need to add tests for median. Let's inspect stats core.")
    llm = ScriptedLLM([exc, reply(("echo", {"text": "hi"})), finish()])
    result = run(make_agent(llm, on_event=notes.append))
    assert result.success and result.steps_used == 3
    assert "provider could not parse the reply (output_parse_failed); using its text" in events_of(notes)
    # The text went into the history as the model's reply, followed by the usual nudge.
    assert llm.requests[1][-2] == {"role": "assistant", "content": "We need to add tests for median. Let's inspect stats core."}
    assert "call `finish`" in llm.requests[1][-1]["content"]


def test_parse_failure_with_a_json_tool_call_runs_the_call():
    exc = BadRequest("parse failed", code="output_parse_failed",
                     failed_generation='{"name": "echo", "arguments": {"text": "from text"}}')
    llm = ScriptedLLM([exc, finish()])
    result = run(make_agent(llm))
    assert result.success
    assert "echo: from text" in tool_results(llm.requests[1])


def test_400_without_failed_generation_is_retried_twice_then_fails():
    notes: list[AgentEvent] = []
    recovered = run(make_agent(ScriptedLLM([BadRequest("x", code="weird")] * 2 + [finish()])))
    assert recovered.success

    llm = ScriptedLLM([BadRequest("bad", code="weird")] * 3 + [finish()])
    result = run(make_agent(llm, on_event=notes.append))
    assert (result.success, result.stop_reason) == (False, "error")
    assert "rejected the request 3 times in a row (400, weird)" in result.summary
    assert len(llm.requests) == 3
    assert events_of(notes)[:2] == [
        "provider rejected the request (400, weird); retry 1/2",
        "provider rejected the request (400, weird); retry 2/2",
    ]


def daily_limit(model, wait=209.0):
    from datetime import datetime

    return DailyLimitReached(model, "Rate limit reached ... on tokens per day (TPD): Limit 200000",
                             retry_after=wait, reset_at=datetime(2026, 10, 18, 17, 35), limit_name="tokens per day (TPD)")


def test_daily_limit_switches_to_the_fallback_with_the_conversation_intact():
    notes: list[AgentEvent] = []
    llm = ScriptedLLM({
        "primary": [reply(("echo", {"text": "one"})), daily_limit("primary")],
        "backup": [finish(summary="done on backup")],
    })
    agent = make_agent(llm, on_event=notes.append, fallback_models=["backup"])
    agent.model = "primary"
    result = run(agent)
    assert (result.success, result.summary) == (True, "done on backup")
    assert result.models_used == ["primary", "backup"]
    [switch] = [e for e in notes if e.kind == "model_switch"]
    assert switch.summary == "daily limit reached on primary, switching to backup"
    assert switch.arguments == {"from": "primary", "to": "backup", "reason": "daily_limit"}
    # The backup got exactly the conversation the primary was about to answer.
    assert llm.requests_for("backup")[0] == llm.requests_for("primary")[1]
    assert "echo: one" in tool_results(llm.requests_for("backup")[0])
    assert result.steps_used == 2  # the switch does not cost a step


def test_all_fallbacks_exhausted_gives_a_clear_error():
    llm = ScriptedLLM({"primary": [daily_limit("primary")], "b1": [daily_limit("b1", wait=60)]})
    agent = make_agent(llm, fallback_models=["b1"])
    agent.model = "primary"
    result = run(agent)
    assert (result.success, result.stop_reason) == (False, "daily_limit")
    assert result.models_used == ["primary", "b1"]
    assert result.summary == (
        "daily limit reached on every model the test may use: "
        "primary (tokens per day (TPD), resets in 3m29s, around 17:35); "
        "b1 (tokens per day (TPD), resets in 1m00s, around 17:35). "
        "Try again after the reset, or add models to TEST_FALLBACKS."
    )


def test_repo_browser_prefix_maps_to_any_of_our_tools(tmp_path: Path):
    from patchwork.agents.lead import build_lead

    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "mod.py").write_text("x = 1\n")
    notes: list[AgentEvent] = []
    llm = ScriptedLLM([
        reply(("repo_browser.list_dir", {"path": "pkg"})),
        reply(("repo_browser.read_file", {"path": "pkg/mod.py"})),
        reply(("repo_browser.print_tree", {"path": ".", "depth": 2})),  # the explicit alias still applies
        reply(("repo_browser.nope", {})),
        finish(success=False, summary="stop"),
    ])
    lead = build_lead(repo=tmp_path, settings=Settings(_env_file=None), llm=llm, on_event=notes.append)
    run(lead)
    results = tool_results(llm.requests[-1])
    assert "mod.py" in results[0] and "x = 1" in results[1] and "pkg/" in results[2]
    assert results[3].startswith("ERROR: unknown tool 'repo_browser.nope'")
    assert [n for n in events_of(notes) if n.startswith("mapped")] == [
        "mapped repo_browser.list_dir -> list_dir", "mapped repo_browser.read_file -> read_file",
        "mapped repo_browser.print_tree -> list_dir",
    ]


def test_unknown_prefixed_tool_rejected_by_provider_gets_the_mapping_hint(tmp_path: Path):
    from patchwork.agents.lead import build_lead

    exc = BadRequest("tool call validation failed: attempted to call tool 'repo_browser.list_dir' "
                     "which was not in request.tools", code="tool_use_failed")
    llm = ScriptedLLM([exc, finish(success=False, summary="stop")])
    run(build_lead(repo=tmp_path, settings=Settings(_env_file=None), llm=llm))
    assert "Call list_dir instead." in llm.requests[1][-1]["content"]


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
    assert tool_results[2].startswith("edited calculator/ops.py at line 11; it now reads:\n")
    assert "\n11|     return a - b\n" in tool_results[2]
    assert tool_results[3].startswith("edited calculator/ops.py at line 23;")
    assert tool_results[4].startswith("PASSED: 1 passed")
    assert tool_results[5].startswith("PASSED: 5 passed")
    assert tool_results[6].startswith("ERROR: finish rejected: the full test suite has not passed")
    assert tool_results[8].startswith("PASSED: 8 passed")
    source = (repo / "calculator" / "ops.py").read_text()
    assert "return a - b" in source and "return a / b" in source


# --- provider 400s: switching models -----------------------------------------------------

def parse_failed(generation=None):
    """Groq's output_parse_failed; the real failure had an empty failed_generation."""
    return BadRequest("Failed to parse the model output", code="output_parse_failed", failed_generation=generation)


ECHO_TEXT = '{"name": "echo", "arguments": {"text": "%s"}}'


def test_three_empty_generation_400s_switch_model_with_the_conversation_kept():
    notes: list[AgentEvent] = []
    llm = ScriptedLLM({
        "small": [reply(("echo", {"text": "one"})), parse_failed(), parse_failed(), parse_failed()],
        "big": [finish(summary="done on big")],
    })
    agent = make_agent(llm, on_event=notes.append, fallback_models=["big"])
    agent.model = "small"
    result = run(agent)
    assert (result.success, result.summary) == (True, "done on big")
    assert result.models_used == ["small", "big"]
    [switch] = [e for e in notes if e.kind == "model_switch"]
    assert switch.summary == (
        "model kept failing on small (rejected 3 requests in a row (400, output_parse_failed)), switching to big"
    )
    assert switch.arguments == {"from": "small", "to": "big", "reason": "bad_requests"}
    # The new model gets the same conversation the failing one kept rejecting.
    assert llm.requests_for("big")[0] == llm.requests_for("small")[-1]
    assert "echo: one" in tool_results(llm.requests_for("big")[0])


def test_400s_with_a_failed_generation_also_count_toward_the_switch():
    llm = ScriptedLLM({
        "small": [parse_failed(ECHO_TEXT % "a"), parse_failed(ECHO_TEXT % "b"), parse_failed()],
        "big": [finish()],
    })
    agent = make_agent(llm, fallback_models=["big"])
    agent.model = "small"
    result = run(agent)
    assert result.success and result.models_used == ["small", "big"]
    # The two calls written as text were run before the switch.
    assert tool_results(llm.requests_for("big")[0]) == ["echo: a", "echo: b"]


def test_with_no_other_model_failed_generations_are_still_used_as_replies():
    llm = ScriptedLLM([parse_failed(ECHO_TEXT % n) for n in "abc"] + [finish()])
    result = run(make_agent(llm))
    assert result.success and result.steps_used == 4


def test_every_model_failing_still_fails_the_agent():
    notes: list[AgentEvent] = []
    llm = ScriptedLLM({"small": [parse_failed()] * 3, "big": [parse_failed()] * 3})
    agent = make_agent(llm, on_event=notes.append, fallback_models=["big"])
    agent.model = "small"
    result = run(agent)
    assert (result.success, result.stop_reason) == (False, "error")
    assert result.models_used == ["small", "big"]
    assert result.summary == (
        "LLM call failed: no usable model left for the test: "
        "small (rejected 3 requests in a row (400, output_parse_failed)); "
        "big (rejected 3 requests in a row (400, output_parse_failed)). Add models to TEST_FALLBACKS."
    )
    assert len([e for e in notes if e.kind == "model_switch"]) == 1


def test_a_daily_limit_and_repeated_400s_together_exhaust_the_models():
    llm = ScriptedLLM({"small": [parse_failed()] * 3, "big": [daily_limit("big")]})
    agent = make_agent(llm, fallback_models=["big"])
    agent.model = "small"
    result = run(agent)
    assert (result.success, result.stop_reason) == (False, "error")
    assert result.summary == (
        "no usable model left for the test: small (rejected 3 requests in a row (400, output_parse_failed)); "
        "big (tokens per day (TPD), resets in 3m29s, around 17:35). Add models to TEST_FALLBACKS."
    )


def test_a_model_given_up_on_is_skipped_by_a_later_daily_limit_switch():
    llm = ScriptedLLM({"a": [parse_failed()] * 3, "b": [daily_limit("b")], "c": [finish(summary="on c")]})
    agent = make_agent(llm, fallback_models=["b", "c"])
    agent.model = "a"
    result = run(agent)
    assert (result.success, result.summary, result.models_used) == (True, "on c", ["a", "b", "c"])


# --- repeated identical calls ------------------------------------------------------------

def peek_agent(llm, calls: list[str], **kwargs) -> Agent:
    """An agent with a read-only `peek` tool (recording its runs) and the file-changing `echo`."""

    def peek(args: EchoArgs) -> ToolOutput:
        calls.append(args.text)
        return ToolOutput(content=f"peeked at {args.text}: no matches")

    def echo(args: EchoArgs) -> ToolOutput:
        return ToolOutput(content="written", files_changed=["f.txt"])

    tools = [
        Tool(name="peek", description="Look.", args_model=EchoArgs, handler=peek),
        Tool(name="echo", description="Write.", args_model=EchoArgs, handler=echo),
    ]
    return make_agent(llm, tools=tools, **kwargs)


def test_a_third_identical_call_with_an_unchanged_result_is_not_run():
    calls: list[str] = []
    llm = ScriptedLLM([reply(("peek", {"text": "tests"}))] * 4 + [finish()])
    result = run(peek_agent(llm, calls))
    assert result.success
    assert calls == ["tests", "tests"]  # the 3rd and 4th were not run
    results = tool_results(llm.requests[-1])
    assert results[2] == (
        "You've made this exact call 3 times and the result hasn't changed. Do something different: "
        "the result is already in your context above; use it, or call a different tool or change the arguments."
    )
    assert results[3].startswith("You've made this exact call 4 times")


def test_a_file_change_or_different_arguments_reset_the_repeat_guard():
    calls: list[str] = []
    llm = ScriptedLLM([
        reply(("peek", {"text": "a"})), reply(("peek", {"text": "a"})),
        reply(("echo", {"text": "x"})),  # files changed: the result may differ now
        reply(("peek", {"text": "a"})), reply(("peek", {"text": "b"})),
        finish(),
    ])
    run(peek_agent(llm, calls))
    assert calls == ["a", "a", "a", "b"]


def test_repeat_guard_uses_the_tool_specific_hint():
    llm = ScriptedLLM([reply(("peek", {"text": "x"}))] * 3 + [finish()])
    run(peek_agent(llm, [], repeat_hint=lambda name, args: f"stop peeking at {args['text']}."))
    assert tool_results(llm.requests[-1])[2].endswith("Do something different: stop peeking at x.")


def test_crew_coder_searching_for_the_testers_tests_is_told_they_are_elsewhere(tmp_path: Path):
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "test_old.py").write_text("def test_old():\n    pass\n")
    search = reply(("search_code", {"path": "tests", "pattern": "slugify"}))
    llm = ScriptedLLM([search] * 3 + [reply(("read_file", {"path": "missing.py"}))] + [finish(success=False, summary="x")] * 2)
    settings = Settings(_env_file=None, coder_model="fake")
    run(build_coder(repo=tmp_path, settings=settings, llm=llm, tests_elsewhere=True))
    results = tool_results(llm.requests[-1])
    assert results[0] == "no matches" and "unchanged" in results[1]
    assert results[2] == (
        "You've made this exact call 3 times and the result hasn't changed. Do something different: the tester "
        "writes the new tests in a separate workspace, so they won't appear in yours. Implement from the issue "
        "and the plan's acceptance criteria, then run run_tests on the existing suite."
    )
