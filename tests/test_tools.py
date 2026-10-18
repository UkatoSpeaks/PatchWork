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
    assert results[1] == (
        "[read_file m.py, lines 1-20: unchanged since your read at step 1 (lines 1-20), "
        "which is still in your context above; not repeated]"
    )
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
    notices = [e.summary for e in events if e.kind == "note"]
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
        "search_code, read_file, list_dir, edit_file, insert_lines, write_file, finish. Call one of them."
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


# --- insert_lines -------------------------------------------------------------------------

def test_insert_lines_top_middle_and_end(repo: Path):
    (repo / "m.py").write_bytes(b"a = 1\nb = 2")  # no trailing newline
    out = fs.insert_lines(repo, "m.py", -1, "\n\ndef f():\n    return a")
    assert out.startswith("inserted 4 line(s) into m.py after line 2; it now reads:\n")
    assert "3| \n4| \n5| def f():\n6|     return a" in out
    fs.insert_lines(repo, "m.py", 0, '"""Doc."""')
    fs.insert_lines(repo, "m.py", 2, "c = 3\n")
    assert (repo / "m.py").read_text() == '"""Doc."""\na = 1\nc = 3\nb = 2\n\n\ndef f():\n    return a\n'


def test_insert_lines_keeps_crlf_and_shows_context(repo: Path):
    (repo / "w.py").write_bytes(MODULE.replace("\n", "\r\n").encode())
    out = fs.insert_lines(repo, "w.py", 10, "y = 0")
    lines = out.splitlines()
    assert lines[1] == " 6| x6 = 6" and "11| y = 0" in lines and lines[-1] == "16| x15 = 15"
    data = (repo / "w.py").read_bytes()
    assert b"x10 = 10\r\ny = 0\r\nx11 = 11\r\n" in data and b"\n" not in data.replace(b"\r\n", b"")


def test_insert_lines_rejects_bad_line_and_invalid_python(repo: Path):
    (repo / "m.py").write_text(MODULE)
    with pytest.raises(ValueError, match="between 0 and 20, or -1"):
        fs.insert_lines(repo, "m.py", 21, "x = 0")
    with pytest.raises(InvalidPython, match="line 6"):
        fs.insert_lines(repo, "m.py", 5, "def broken(:")
    assert (repo / "m.py").read_text() == MODULE


def test_insert_lines_tool_applies_write_guards(repo: Path):
    from patchwork.agents.toolkit import WriteNotAllowed, protect

    (repo / "m.py").write_text(MODULE)
    tools = {t.name: t for t in write_tools(repo, guard=protect(["m.py"]))}
    with pytest.raises(WriteNotAllowed, match="read-only for you"):
        asyncio.run(tools["insert_lines"].invoke({"path": "m.py", "after_line": -1, "text": "z = 0"}))
    assert (repo / "m.py").read_text() == MODULE


# --- repeated reads at other offsets ----------------------------------------------------------

def test_reads_of_an_unchanged_file_at_other_offsets_get_the_short_note(repo: Path):
    (repo / "m.py").write_text(MODULE)
    big = "".join(f"line_{i} = {i}\n" for i in range(1, 301))
    (repo / "big.py").write_text(big)
    llm = ScriptedLLM([
        reply(("read_file", {"path": "m.py"})),
        reply(("read_file", {"path": "m.py", "offset": 10})),
        reply(("read_file", {"path": "big.py"})),
        reply(("read_file", {"path": "big.py", "offset": 201})),  # not covered: full
        reply(("read_file", {"path": "big.py", "offset": 250})),  # inside page 2: note
        finish(),
    ])
    events = []
    asyncio.run(_agent(repo, llm, on_event=events.append).run("go"))
    results = tool_results(llm.requests[-1])
    assert results[1] == (
        "[read_file m.py, lines 10-20: unchanged since your read at step 1 (lines 1-20), "
        "which is still in your context above; not repeated]"
    )
    assert results[3].startswith("201| line_201 = 201")
    assert results[4].startswith("[read_file big.py, lines 250-300: unchanged since your read at step 4 (lines 201-300)")
    summaries = [e.summary for e in events if e.kind == "tool_result"]
    assert summaries[1] == "m.py: lines 10-20 of 20 (unchanged, short note)"
    assert summaries[3] == "big.py: lines 201-300 of 300"
    assert summaries[4].endswith("(unchanged, short note)")


# --- tolerant text tool calls ------------------------------------------------------------------

def test_text_tool_call_with_raw_newlines_in_content_is_executed(repo: Path):
    content = 'import stats\n\n\ndef test_a():\n    assert stats.mean([1, 3]) == 2\n    assert "a\tb"\n'
    # Long file content written with literal newlines inside the JSON string (invalid strict JSON).
    text = '{"name": "write_file", "arguments": {"path": "tests/test_a.py", "content": "' + content.replace('"', '\\"') + '"}}'
    llm = ScriptedLLM([reply(content=text), finish()])
    asyncio.run(_agent(repo, llm).run("go"))
    assert (repo / "tests" / "test_a.py").read_text() == content
    assert tool_results(llm.requests[-1])[0].startswith("wrote ")


@pytest.mark.parametrize(
    "text",
    [
        '{"name": "list_dir", "arguments": {"path": "."},}',  # needs json-repair
        'Calling it now: {"name": "list_dir", "arguments": {}} as planned',  # outermost {...} block
    ],
    ids=["repaired", "extracted"],
)
def test_text_tool_call_is_repaired_or_extracted(repo: Path, text: str):
    (repo / "m.py").write_text("")
    llm = ScriptedLLM([reply(content=text), finish()])
    asyncio.run(_agent(repo, llm).run("go"))
    assert tool_results(llm.requests[-1]) == ["m.py"]


def test_unparseable_text_tool_call_gets_an_error_not_silence(repo: Path):
    llm = ScriptedLLM([
        reply(content='{"name": "write_file", "arguments": '),
        reply(content="Hmm."),  # would be the second prose reply if the call above counted as prose
        finish(summary="ok"),
    ])
    result = asyncio.run(_agent(repo, llm).run("go"))
    assert (result.success, result.steps_used) == (True, 3)
    assert llm.requests[1][-1] == {
        "role": "user",
        "content": "ERROR: your tool call written as text could not be parsed as JSON, so it was not run. "
        "Call the tool natively (as a function call), not as text.",
    }


def test_cut_off_text_tool_call_is_not_run(repo: Path):
    from patchwork.llm import LLMResponse

    cut = LLMResponse(model="m", content='{"name": "write_file", "arguments": {"path": "a.py", "content": "x = 1\ny =',
                      finish_reason="length")
    llm = ScriptedLLM([cut, finish()])
    asyncio.run(_agent(repo, llm).run("go"))
    assert not (repo / "a.py").exists()
    assert llm.requests[1][-1]["content"].startswith("ERROR: your reply was cut off at the output token limit")


# --- duplicate definitions --------------------------------------------------------------------

def test_duplicate_top_level_definition_is_written_with_a_warning(repo: Path):
    from patchwork.agents.toolkit import write_tools

    source = "def mean(v):\n    return 1\n\n\ndef median(v):\n    return 2\n"
    (repo / "core.py").write_text(source)
    tools = {t.name: t for t in write_tools(repo)}
    out = asyncio.run(tools["insert_lines"].invoke({"path": "core.py", "after_line": -1,
                                                    "text": "\n\ndef median(v):\n    return 3\n"}))
    assert out.content.endswith("\nWARNING: median is now defined twice (lines 5 and 9); remove one")
    assert out.summary.endswith("(WARNING: duplicate definition)")
    assert (repo / "core.py").read_text().count("def median") == 2  # still written

    out = fs.write_file(repo, "three.py", "class A: ...\nclass A: ...\nclass A: ...\n")
    assert out.endswith("WARNING: A is now defined 3 times (lines 1, 2 and 3); remove one")
    # @overload stubs, nested functions and non-Python files are not flagged.
    clean = (
        "from typing import overload\n\n\n@overload\ndef f(x: int) -> int: ...\n@overload\ndef f(x: str) -> str: ...\n"
        "def f(x):\n    def g(): ...\n    def g(): ...\n    return x\n"
    )
    assert "WARNING" not in fs.write_file(repo, "ok.py", clean)
    assert "WARNING" not in fs.write_file(repo, "notes.txt", "def a(): ...\ndef a(): ...\n")
