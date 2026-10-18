"""Tool-layer behaviour shared by all agents: edit/write feedback, syntax guard,
path suggestions, history trimming of file reads, and JSON-text tool calls."""

import asyncio
import sys
from pathlib import Path

import pytest

from patchwork.agents.base import Agent
from patchwork.agents.toolkit import read_only_tools, write_tools
from patchwork.tools import fs
from patchwork.tools.fs import InvalidPython
from patchwork.tools.shell import run_tests

from scripted import ScriptedLLM, finish, reply, tool_results

MODULE = "".join(f"x{i} = {i}\n" for i in range(1, 21))  # 20 lines


# --- edit_file / write_file ---------------------------------------------------------

def test_crlf_file_edited_with_lf_text(repo: Path):
    (repo / "w.py").write_bytes(b"def f():\r\n    a = 1\r\n    return a\r\n")
    out = fs.edit_file(repo, "w.py", "    a = 1\n    return a\n", "    a = 2\n    return a\n")
    assert out.startswith("edited w.py at line 2;")
    assert (repo / "w.py").read_bytes() == b"def f():\r\n    a = 2\r\n    return a\r\n"


def test_write_file_keeps_crlf_of_existing_file(repo: Path):
    (repo / "w.txt").write_bytes(b"a\r\nb\r\n")
    fs.write_file(repo, "w.txt", "a\nc\n")
    assert (repo / "w.txt").read_bytes() == b"a\r\nc\r\n"


def test_edit_result_shows_edited_region_with_context(repo: Path):
    (repo / "m.py").write_text(MODULE)
    out = fs.edit_file(repo, "m.py", "x10 = 10\n", "x10 = 100\nx10b = 101\n")
    head, *region = out.splitlines()
    assert head == "edited m.py at line 10; it now reads:"
    assert region[0] == " 5| x5 = 5"
    assert " 10| x10 = 100" in [f" {line}" for line in region]
    assert "11| x10b = 101" in region
    assert region[-1] == "16| x15 = 15"  # 5 lines after the last edited line


def test_write_file_result_shows_new_file_and_changed_region(repo: Path):
    out = fs.write_file(repo, "pkg/new.py", "a = 1\nb = 2\n")
    assert out == "wrote 12 chars to pkg/new.py (new file, 2 lines)\n1| a = 1\n2| b = 2"
    (repo / "m.py").write_text(MODULE)
    out = fs.write_file(repo, "m.py", MODULE.replace("x3 = 3", "x3 = 33"))
    assert out.splitlines()[0] == "wrote 163 chars to m.py (20 lines); changed lines 3-3:"
    assert "3| x3 = 33" in out and "8| x8 = 8" in out and "9| x9" not in out


def test_edit_not_found_shows_closest_region(repo: Path):
    (repo / "core.py").write_text(
        "def mean(values):\n    return sum(values) / len(values)\n\n\n"
        "def data_range(values):\n    return max(values) - min(values)\n"
    )
    with pytest.raises(ValueError) as info:
        fs.edit_file(repo, "core.py", "def data_range(vals):\n    return max(vals) - min(vals)", "x")
    message = str(info.value)
    assert message.startswith("old text not found in core.py. The closest match is lines 5-6")
    assert "5| def data_range(values):" in message
    assert "6|     return max(values) - min(values)" in message
    assert "without the" in message


def test_edit_accepts_text_copied_with_line_number_prefixes(repo: Path):
    (repo / "m.py").write_text(MODULE)
    fs.edit_file(repo, "m.py", " 3| x3 = 3\n 4| x4 = 4", " 3| x3 = 3\n 4| x4 = 44")
    assert "x4 = 44\n" in (repo / "m.py").read_text()


def test_syntax_breaking_edit_is_refused_and_file_unchanged(repo: Path):
    (repo / "m.py").write_text(MODULE)
    with pytest.raises(InvalidPython) as info:
        fs.edit_file(repo, "m.py", "x7 = 7", "x7 = (7")
    assert "invalid Python" in str(info.value) and "the file was not changed" in str(info.value)
    assert "line 7" in str(info.value)
    with pytest.raises(InvalidPython):
        fs.write_file(repo, "m.py", "def broken(:\n")
    with pytest.raises(InvalidPython):
        fs.write_file(repo, "brand_new.py", "if True\n")
    assert (repo / "m.py").read_text() == MODULE
    assert not (repo / "brand_new.py").exists()
    # Only .py files are parsed.
    fs.write_file(repo, "notes.txt", "def broken(:\n")


# --- read_file / paths ----------------------------------------------------------------

def _tool(repo: Path, name: str):
    return {t.name: t for t in read_only_tools(repo) + write_tools(repo)}[name]


def test_read_file_on_a_directory_returns_its_listing(repo: Path):
    (repo / "tests").mkdir()
    (repo / "tests" / "test_core.py").write_text("")
    out = asyncio.run(_tool(repo, "read_file").invoke({"path": "tests"}))
    assert out.content == "tests is a directory; its entries:\ntest_core.py"
    assert not out.is_error


def test_missing_path_suggests_close_matches(repo: Path):
    (repo / "tests").mkdir()
    (repo / "tests" / "test_core.py").write_text("")
    (repo / "stats").mkdir()
    (repo / "stats" / "core.py").write_text("")
    with pytest.raises(FileNotFoundError, match=r"no such file: test_core.py; did you mean tests/test_core.py"):
        fs.read_file(repo, "test_core.py")
    with pytest.raises(FileNotFoundError, match="did you mean stats/core.py"):
        fs.edit_file(repo, "stat/core.py", "a", "b")
    with pytest.raises(FileNotFoundError, match="no such file: zzz.qq$"):
        fs.read_file(repo, "zzz.qq")


# --- history: latest read kept, repeats replaced, JSON-text calls -----------------------

def _agent(repo: Path, llm, **kwargs) -> Agent:
    return Agent(role="t", model="m", system_prompt="s", tools=read_only_tools(repo) + write_tools(repo), llm=llm, **kwargs)


def test_repeated_read_of_unchanged_file_returns_a_short_note(repo: Path):
    (repo / "m.py").write_text(MODULE)
    llm = ScriptedLLM([
        reply(("read_file", {"path": "m.py"})),
        reply(("read_file", {"path": "./m.py"})),
        reply(("edit_file", {"path": "m.py", "old": "x1 = 1\n", "new": "x1 = 11\n"})),
        reply(("read_file", {"path": "m.py"})),
        finish(),
    ])
    asyncio.run(_agent(repo, llm).run("go"))
    results = tool_results(llm.requests[-1])
    assert results[1].startswith("[unchanged since your identical call at step 1;")
    # The file changed, so the next read is returned in full and the old one is stubbed.
    assert results[0] == "[superseded by a later result for read_file m.py]"
    assert results[3].startswith(" 1| x1 = 11")


def test_latest_read_of_each_file_survives_trimming(repo: Path):
    big = "".join(f"line_{i} = {i}\n" for i in range(100))
    (repo / "big.py").write_text(big)
    (repo / "other.py").write_text(big)
    llm = ScriptedLLM(
        [reply(("read_file", {"path": "big.py"}))]
        + [reply(("search_code", {"pattern": f"line_{i} ="})) for i in range(4)]
        + [finish()]
    )
    asyncio.run(_agent(repo, llm, keep_recent_tool_results=2, keep_recent_views=1).run("go"))
    results = tool_results(llm.requests[-1])
    # With only the newest view pinned, the read is trimmed like any other old result.
    assert results[0].endswith("re-run the tool if you need it]")

    llm = ScriptedLLM(
        [reply(("read_file", {"path": "big.py"}))]
        + [reply(("search_code", {"pattern": f"line_{i} ="})) for i in range(4)]
        + [finish()]
    )
    asyncio.run(_agent(repo, llm, keep_recent_tool_results=2, keep_recent_views=6).run("go"))
    results = tool_results(llm.requests[-1])
    assert results[0] == fs.read_file(repo, "big.py")  # pinned in full


def test_tool_call_written_as_json_text_is_executed(repo: Path):
    (repo / "m.py").write_text(MODULE)
    llm = ScriptedLLM([
        reply(content='{"name": "read_file", "arguments": {"path": "m.py"}}'),
        reply(content='```json\n{"name": "search_code", "parameters": "{\\"pattern\\": \\"x2 =\\"}"}\n```'),
        finish(),
    ])
    events = []
    result = asyncio.run(_agent(repo, llm, on_event=events.append).run("go"))
    assert result.success and result.steps_used == 3
    last = llm.requests[-1]
    calls = [m["tool_calls"][0]["function"]["name"] for m in last if m.get("tool_calls")]
    assert calls == ["read_file", "search_code"]
    assert tool_results(last)[0].startswith(" 1| x1 = 1")
    assert tool_results(last)[1] == "m.py:2: x2 = 2"
    assert "tool call written as text; running read_file" in [e.summary for e in events]


# --- run_tests output ---------------------------------------------------------------------

def test_failed_run_leads_with_the_failure_reason(tmp_path: Path):
    (tmp_path / "test_x.py").write_text("from missing_module_xyz import thing\n\n\ndef test_a():\n    assert thing\n")
    result = run_tests(tmp_path, [sys.executable, "-m", "pytest", "-q", "--tb=short", "-p", "no:cacheprovider"])
    lines = result.render().splitlines()
    assert lines[0].startswith("FAILED (exit 2)")
    assert lines[1].startswith("reason: ") and "ModuleNotFoundError: No module named 'missing_module_xyz'" in lines[1]
    assert lines[2].startswith("--- output (last ")


# --- gpt-oss tool aliases, unknown tools, JSON text vs prose ----------------------------

def _alias_agent(repo: Path, llm, **kwargs) -> Agent:
    from patchwork.agents.toolkit import TOOL_ALIASES

    return _agent(repo, llm, aliases=TOOL_ALIASES, **kwargs)


def test_repo_browser_aliases_are_mapped_and_executed(repo: Path):
    (repo / "m.py").write_text(MODULE)
    llm = ScriptedLLM([
        reply(("repo_browser.print_tree", {"path": "", "depth": 2})),
        reply(content='{"name": "repo_browser.open_file", "arguments": {"path": "m.py", "line_start": 5, "line_end": 8}}'),
        reply(("repo_browser.search", {"query": "x2 =", "path": ""})),
        finish(),
    ])
    events = []
    result = asyncio.run(_alias_agent(repo, llm, on_event=events.append).run("go"))

    assert result.success and result.steps_used == 4
    last = llm.requests[-1]
    calls = [m["tool_calls"][0]["function"] for m in last if m.get("tool_calls")]
    assert [c["name"] for c in calls] == ["list_dir", "read_file", "search_code"]
    results = tool_results(last)
    assert results[0] == "m.py"
    assert results[1].startswith(" 5| x5 = 5")
    assert results[2] == "m.py:2: x2 = 2"
    notices = [e.summary for e in events if e.kind == "notice"]
    for alias, target in [("print_tree", "list_dir"), ("open_file", "read_file"), ("search", "search_code")]:
        assert f"mapped repo_browser.{alias} -> {target}" in notices


@pytest.mark.parametrize("as_text", [False, True], ids=["native", "json-text"])
def test_unknown_tool_returns_the_tool_list_and_the_run_continues(repo: Path, as_text: bool):
    call = ("repo_browser.fetch", {"url": "x"})
    first = reply(content='{"name": "repo_browser.fetch", "arguments": {"url": "x"}}') if as_text else reply(call)
    llm = ScriptedLLM([first, reply(("list_dir", {})), finish()])
    result = asyncio.run(_alias_agent(repo, llm).run("go"))
    assert result.success and result.steps_used == 3
    assert tool_results(llm.requests[1])[-1] == (
        "ERROR: unknown tool 'repo_browser.fetch'. The only tools you can call are: "
        "search_code, read_file, list_dir, edit_file, write_file, finish. Call one of them."
    )


def test_json_text_tool_calls_never_count_as_a_prose_answer(repo: Path):
    # Prose and JSON-text calls alternate. If a JSON-text call counted as prose,
    # the second reply would already be taken as the final answer.
    llm = ScriptedLLM([
        reply(content="Let me look around."),
        reply(content='{"name": "repo_browser.print_tree", "arguments": {"path": "", "depth": 2}}'),
        reply(content="Still thinking."),
        reply(content='{"name": "nonexistent_tool", "arguments": {}}'),
        reply(content="Almost there."),
        finish(summary="done for real"),
    ])
    # Without aliases, repo_browser.print_tree is an unknown tool too.
    result = asyncio.run(_agent(repo, llm).run("go"))
    assert (result.success, result.summary, result.steps_used) == (True, "done for real", 6)
    assert tool_results(llm.requests[-1])[0].startswith("ERROR: unknown tool 'repo_browser.print_tree'")
