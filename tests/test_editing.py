"""Line-range editing, edit_file ambiguity, the unreachable-code warning, the
repeated-call guard for reads, stuck detection and history trimming.

The scenario is the one a real text_utils run got stuck on: a stray docstring
and ``return`` left after slugify's return, whose text also appears earlier
in the file."""

import asyncio
from pathlib import Path

import pytest

from patchwork.agents.base import Agent, AgentEvent
from patchwork.agents.coder import SYSTEM_PROMPT, build_coder
from patchwork.agents.toolkit import WriteNotAllowed, protect, read_only_tools, repeat_hint, write_tools
from patchwork.config import Settings
from patchwork.tools import fs
from patchwork.tools.fs import InvalidPython

from scripted import ScriptedLLM, finish, reply, results_as_sent, tool_results

CORE = (
    '"""Small text helpers."""\n'           # 1
    "import re\n"                           # 2
    "\n"                                    # 3
    "\n"                                    # 4
    "def word_count(text):\n"               # 5
    '    """Count the words in text."""\n'  # 6
    "    return len(text.split())\n"        # 7
    "\n"                                    # 8
    "\n"                                    # 9
    "def slugify(text):\n"                  # 10
    '    """Turn text into a URL slug."""\n'  # 11
    '    slug = re.sub(r"[^a-z0-9]+", "-", text.lower())\n'  # 12
    '    return slug.strip("-")\n'          # 13
    '    """Count the words in text."""\n'  # 14  stray copy
    "    return len(text.split())\n"        # 15  stray copy
)
STRAY = '    """Count the words in text."""\n    return len(text.split())\n'


@pytest.fixture
def core(repo: Path) -> Path:
    (repo / "text_utils").mkdir()
    (repo / "text_utils" / "core.py").write_text(CORE)
    return repo


def tools(repo: Path, **kwargs):
    return {t.name: t for t in read_only_tools(repo) + write_tools(repo, **kwargs)}


def invoke(repo: Path, name: str, **arguments):
    return asyncio.run(tools(repo)[name].invoke(arguments))


# --- replace_lines ------------------------------------------------------------------------------

def test_replace_lines_deletes_lines_and_shows_the_region(core: Path):
    out = invoke(core, "replace_lines", path="text_utils/core.py", start_line=14, end_line=15, text="")
    assert (core / "text_utils" / "core.py").read_text() == CORE.removesuffix(STRAY)
    assert out.content == (
        "deleted lines 14-15 of text_utils/core.py; it now reads:\n"
        ' 9| \n10| def slugify(text):\n11|     """Turn text into a URL slug."""\n'
        '12|     slug = re.sub(r"[^a-z0-9]+", "-", text.lower())\n13|     return slug.strip("-")'
    )
    assert out.summary == "deleted lines 14-15 of text_utils/core.py"
    assert out.files_changed == ["text_utils/core.py"]


def test_replace_lines_replaces_with_more_lines_and_keeps_crlf(repo: Path):
    (repo / "m.py").write_bytes(b"a = 1\r\nb = 2\r\nc = 3\r\n")
    out = fs.replace_lines(repo, "m.py", 2, 2, "b = 20\nb2 = 21")
    assert (repo / "m.py").read_bytes() == b"a = 1\r\nb = 20\r\nb2 = 21\r\nc = 3\r\n"
    assert out == "replaced line 2 of m.py with 2 line(s); it now reads:\n1| a = 1\n2| b = 20\n3| b2 = 21\n4| c = 3"


def test_replace_lines_guards(core: Path):
    path = core / "text_utils" / "core.py"
    with pytest.raises(ValueError, match=r"need 1 <= start_line <= end_line <= 15 .* got start_line=14, end_line=16"):
        fs.replace_lines(core, "text_utils/core.py", 14, 16, "")
    with pytest.raises(ValueError, match="start_line=3, end_line=2"):
        fs.replace_lines(core, "text_utils/core.py", 3, 2, "")
    # Syntax guard: deleting slugify's body would leave a def with no body.
    with pytest.raises(InvalidPython, match="invalid Python"):
        fs.replace_lines(core, "text_utils/core.py", 11, 15, "")
    with pytest.raises(fs.PathOutsideRootError):
        fs.replace_lines(core, "../outside/secret.txt", 1, 1, "")
    # Write guards apply as for edit_file.
    guarded = tools(core, guard=protect(["text_utils/core.py"]))
    with pytest.raises(WriteNotAllowed, match="read-only for you"):
        asyncio.run(guarded["replace_lines"].invoke({"path": "text_utils/core.py", "start_line": 1, "end_line": 1, "text": ""}))
    assert path.read_text() == CORE


def test_replace_lines_warns_about_a_duplicate_definition(core: Path):
    out = invoke(core, "replace_lines", path="text_utils/core.py", start_line=14, end_line=15,
                 text="\n\ndef word_count(text):\n    return 0\n")
    assert "WARNING: word_count is now defined twice (lines 5 and 16); remove one" in out.content
    assert out.summary.endswith("(WARNING: duplicate definition)")


def test_tester_and_coder_get_replace_lines(core: Path):
    from patchwork.agents.tester import build_tester

    settings = Settings(_env_file=None)
    coder = build_coder(repo=core, settings=settings, llm=ScriptedLLM([]))
    tester = build_tester(repo=core, settings=settings, llm=ScriptedLLM([]))
    assert "replace_lines" in coder.tools and "replace_lines" in tester.tools
    assert "prefer replace_lines(path, start_line, end_line, text), especially for deleting code" in SYSTEM_PROMPT
    # The tester's guards still apply: it may only write new test files.
    with pytest.raises(WriteNotAllowed, match="not a test file"):
        asyncio.run(tester.tools["replace_lines"].invoke(
            {"path": "text_utils/core.py", "start_line": 14, "end_line": 15, "text": ""}))


# --- edit_file ambiguity --------------------------------------------------------------------------

def test_ambiguous_edit_suggests_near_line_and_replace_lines(core: Path):
    with pytest.raises(ValueError) as error:
        fs.edit_file(core, "text_utils/core.py", STRAY, "")
    assert str(error.value) == (
        "old text occurs 2 times in text_utils/core.py (at lines 6, 14). Pass near_line to pick one "
        "(e.g. near_line=14), or use replace_lines(text_utils/core.py, 14, 15, '') to delete lines 14-15 "
        "(or pass the new text instead of ''), or include more context"
    )
    assert (core / "text_utils" / "core.py").read_text() == CORE


def test_near_line_picks_the_closest_occurrence(core: Path):
    out = invoke(core, "edit_file", path="text_utils/core.py", old=STRAY, new="", near_line=30)
    text = (core / "text_utils" / "core.py").read_text()
    assert text.count(STRAY) == 1 and text.endswith('    return slug.strip("-")\n')
    assert out.summary == "edited text_utils/core.py at line 14"
    # Closest to line 7 is the first one.
    (core / "text_utils" / "core.py").write_text(CORE)
    fs.edit_file(core, "text_utils/core.py", "    return len(text.split())\n", "    return len(text.split(' '))\n", near_line=7)
    lines = (core / "text_utils" / "core.py").read_text().splitlines()
    assert (lines[6], lines[14]) == ("    return len(text.split(' '))", "    return len(text.split())")
    # near_line is ignored when the text is unique.
    fs.edit_file(core, "text_utils/core.py", "import re\n", "import re  # regex\n", near_line=99)
    assert "import re  # regex" in (core / "text_utils" / "core.py").read_text()


# --- unreachable code -----------------------------------------------------------------------------

def test_unreachable_code_is_written_with_a_warning(repo: Path):
    out = asyncio.run(tools(repo)["write_file"].invoke({"path": "text_utils/core.py", "content": CORE}))
    assert out.content.endswith("\nWARNING: lines 14-15 are unreachable (after the return on line 13)")
    assert out.summary.endswith("(WARNING: unreachable code)")
    assert (repo / "text_utils" / "core.py").read_text() == CORE  # still written

    loops = (
        "def f(items):\n"
        "    for x in items:\n"
        "        if x:\n"
        "            continue\n"
        "            print(x)\n"
        "        break\n"
        "    raise ValueError()\n"
        "    return 1\n"
    )
    assert fs.write_file(repo, "loops.py", loops).split("\n")[-2:] == [
        "WARNING: line 5 is unreachable (after the continue on line 4)",
        "WARNING: line 8 is unreachable (after the raise on line 7)",
    ]
    # A return at the end of a block, or code after an if that returns, is fine.
    clean = "def g(x):\n    if x:\n        return 1\n    return 2\n"
    assert "WARNING" not in fs.write_file(repo, "clean.py", clean)
    assert "WARNING" not in fs.write_file(repo, "notes.txt", "return 1\nx = 2\n")
    # Any edit to a .py file reports it, e.g. an insert after a return.
    out = fs.insert_lines(repo, "clean.py", 3, "        x += 1")
    assert out.endswith("WARNING: line 4 is unreachable (after the return on line 3)")


# --- the repeated-call guard for reads ---------------------------------------------------------------

def _agent(repo: Path, llm, **kwargs) -> Agent:
    return Agent(role="coder", model="m", system_prompt="s", tools=read_only_tools(repo) + write_tools(repo),
                 llm=llm, repeat_hint=repeat_hint(), **kwargs)


READ = ("read_file", {"path": "text_utils/core.py"})


def test_a_repeated_read_still_in_context_is_shown_again_with_the_warning(core: Path):
    llm = ScriptedLLM([reply(READ), reply(READ), reply(READ), finish()])
    events: list[AgentEvent] = []
    asyncio.run(_agent(core, llm, on_event=events.append).run("go"))
    results = results_as_sent(llm)
    full = fs.read_file(core, "text_utils/core.py")
    assert results[0] == full
    assert results[1].startswith("[read_file text_utils/core.py, lines 1-15: unchanged since your read at step 1")
    assert results[2] == (
        "You've made this exact call 3 times and the result hasn't changed. Do something different: the lines "
        "are shown again below. Act on them: edit with replace_lines (using these line numbers) or edit_file "
        "with near_line, or read another file.\n" + full
    )
    # The copy with the warning replaces the earlier one, so the lines are in context once.
    assert tool_results(llm.requests[-1])[0] == "[superseded by a later result for read_file text_utils/core.py]"
    summaries = [e.summary for e in events if e.kind == "tool_result"]
    assert summaries[2] == "repeated 3 times: shown again with a warning (text_utils/core.py: lines 1-15 of 15)"


def test_a_repeated_read_whose_earlier_copy_was_trimmed_runs_normally(core: Path):
    searches = [reply(("search_code", {"pattern": p})) for p in ("def", "text", "return")]
    llm = ScriptedLLM([reply(READ), *searches, reply(READ), *searches, reply(READ), finish()])
    events: list[AgentEvent] = []
    result = asyncio.run(_agent(core, llm, on_event=events.append).run("go"))
    assert result.success and result.stop_reason == "finished"
    full = fs.read_file(core, "text_utils/core.py")
    reads = [r for r in results_as_sent(llm) if "core.py" in r and "|" in r]
    # Each time, the earlier read had been trimmed to one line, so the read runs as normal.
    assert reads == [full, full, full]
    assert tool_results(llm.requests[4])[0].startswith("[trimmed: read_file: text_utils/core.py: lines 1-15 of 15")
    assert not any("repeated" in e.summary or "not run" in e.summary for e in events if e.kind == "tool_result")


# --- stuck detection ------------------------------------------------------------------------------

def test_three_guard_blocks_end_the_attempt_as_stuck(core: Path):
    llm = ScriptedLLM([reply(("list_dir", {"path": "text_utils"}))] * 6 + [finish()])
    events: list[AgentEvent] = []
    result = asyncio.run(_agent(core, llm, on_event=events.append).run("go"))
    assert (result.success, result.stop_reason, result.steps_used) == (False, "stuck", 5)
    assert result.summary == "stuck: blocked 3 times by the repeated-call guard (last: list_dir)"
    assert [e.kind for e in events][-1] == "stuck"
    assert len(llm.requests) == 5  # ended early, not at max steps


def test_repeated_ambiguous_edits_end_the_attempt_as_stuck(core: Path):
    # Different arguments each time, so the repeated-call guard never trips; the same error does.
    edits = [reply(("edit_file", {"path": "text_utils/core.py", "old": STRAY, "new": "#" * n})) for n in range(1, 5)]
    llm = ScriptedLLM([edits[0], reply(READ), edits[1], reply(("list_dir", {})), edits[2], edits[3], finish()])
    result = asyncio.run(_agent(core, llm, max_steps=20).run("go"))
    assert (result.success, result.stop_reason, result.steps_used) == (False, "stuck", 5)
    assert result.summary == (
        "stuck: edit_file failed 3 times in a row with the same error "
        "(ValueError: old text occurs N times in text_utils/core.py (at lines N, N))"
    )


def test_a_successful_call_or_a_file_change_resets_the_error_streak(core: Path):
    bad = [reply(("edit_file", {"path": "text_utils/core.py", "old": f"nope {n}", "new": "x"})) for n in range(4)]
    fix = reply(("replace_lines", {"path": "text_utils/core.py", "start_line": 14, "end_line": 15, "text": ""}))
    llm = ScriptedLLM([bad[0], bad[1], fix, bad[2], bad[3], finish(success=False, summary="gave up")])
    result = asyncio.run(_agent(core, llm).run("go"))
    assert result.stop_reason == "finished" and result.summary == "gave up"


def test_llm_calls_are_counted(core: Path):
    llm = ScriptedLLM([reply(READ, prompt=300), reply(READ, prompt=500), finish(prompt=700)])
    result = asyncio.run(_agent(core, llm).run("go"))
    assert (result.llm_calls, result.prompt_tokens) == (3, 1500)
