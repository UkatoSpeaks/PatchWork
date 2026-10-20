"""Milestone 2: lead, tester and reviewer agents and the orchestrator, with a scripted LLM."""

import asyncio
from pathlib import Path

import pytest
from pydantic import ValidationError

from patchwork.agents.coder import build_coder
from patchwork.agents.lead import build_lead
from patchwork.agents.reviewer import build_reviewer
from patchwork.agents.tester import FailingTestGate, build_tester
from patchwork.agents.toolkit import NO_REREAD, WriteNotAllowed, is_test_path, tests_only, write_tools
from patchwork.config import Settings
from patchwork.orchestrator import Orchestrator
from patchwork.schemas import Plan, ReviewVerdict
from patchwork.snapshot import Snapshot

from conftest import TOY_STATS, copy_toy
from scripted import ScriptedLLM, finish, reply, results_as_sent, tool_results

TEST_COMMAND = "python -m pytest -q --tb=short -p no:cacheprovider"


def settings(**overrides) -> Settings:
    values = dict(
        lead_model="lead", tester_model="tester", coder_model="coder", reviewer_model="reviewer",
        max_steps_per_agent=10, test_command=TEST_COMMAND,
    )
    return Settings(_env_file=None, **{**values, **overrides})


@pytest.fixture
def stats_repo(tmp_path: Path) -> Path:
    return copy_toy(TOY_STATS, tmp_path)


VALID_PLAN = {
    "issue_summary": "Add median() to the stats package.",
    "subtasks": [
        {"id": "t1", "role": "tester", "description": "Test median for odd, even and empty lists.",
         "files_hint": ["tests/test_median.py", "stats/core.py"], "acceptance_criteria": ["median([]) raises ValueError"]},
        {"id": "c1", "role": "coder", "description": "Implement median() in stats/core.py and export it.",
         "files_hint": ["stats/core.py", "stats/__init__.py"], "acceptance_criteria": ["median([1, 2]) == 1.5"]},
    ],
    "risks": ["even-length lists need the mean of the two middle values"],
}

MEDIAN_TESTS = '''import pytest

import stats


def test_median_odd():
    assert stats.median([3, 1, 2]) == 2


def test_median_even():
    assert stats.median([4, 1, 3, 2]) == 2.5


def test_median_empty():
    with pytest.raises(ValueError):
        stats.median([])
'''

PASSING_TESTS = '''import stats


def test_mean_again():
    assert stats.mean([1, 2, 3]) == 2
'''

MEDIAN_IMPL = '''    return max(values) - min(values)


def median(values):
    """Middle value; the mean of the two middle values for an even count. Raises ValueError on an empty sequence."""
    if not values:
        raise ValueError("median() of an empty sequence")
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2'''

STATS_INIT = '''"""A tiny descriptive-statistics package."""

from stats.core import data_range, mean, median, mode

__all__ = ["data_range", "mean", "median", "mode"]
'''


def run(agent, task="do it"):
    return asyncio.run(agent.run(task))


def submit_plan(plan) -> object:
    return reply(("submit_plan", plan))


def submit_review(approved=True, issues=(), summary="Looks good.") -> object:
    return reply(("submit_review", {"approved": approved, "issues": list(issues), "summary": summary}))


# --- schemas -------------------------------------------------------------------

def test_plan_validation():
    plan = Plan.model_validate({**VALID_PLAN, "subtasks": [{**VALID_PLAN["subtasks"][1], "id": 7}]})
    assert plan.subtasks[0].id == "7"
    assert [s.id for s in Plan.model_validate(VALID_PLAN).for_role("tester")] == ["t1"]

    with pytest.raises(ValidationError, match="role"):
        Plan.model_validate({**VALID_PLAN, "subtasks": [{**VALID_PLAN["subtasks"][1], "role": "designer"}]})
    with pytest.raises(ValidationError, match='role "coder"'):
        Plan.model_validate({**VALID_PLAN, "subtasks": [VALID_PLAN["subtasks"][0]]})
    with pytest.raises(ValidationError, match="unique"):
        Plan.model_validate({**VALID_PLAN, "subtasks": [VALID_PLAN["subtasks"][1]] * 2})
    with pytest.raises(ValidationError):
        Plan.model_validate({**VALID_PLAN, "subtasks": []})


def test_review_verdict_cannot_approve_with_blockers():
    blocker = {"severity": "blocker", "file": "a.py", "description": "uses eval"}
    with pytest.raises(ValidationError, match="blocker"):
        ReviewVerdict.model_validate({"approved": True, "issues": [blocker], "summary": "x"})
    verdict = ReviewVerdict.model_validate({"approved": False, "issues": [blocker], "summary": "x"})
    assert verdict.issues[0].severity == "blocker"


def test_every_role_prompt_forbids_rereading_written_files(stats_repo: Path):
    llm = ScriptedLLM([])
    agents = [
        build_lead(repo=stats_repo, settings=settings(), llm=llm),
        build_tester(repo=stats_repo, settings=settings(), llm=llm),
        build_coder(repo=stats_repo, settings=settings(), llm=llm),
        build_reviewer(repo=stats_repo, settings=settings(), llm=llm),
    ]
    assert all(NO_REREAD in a.system_prompt for a in agents)
    assert [a.model for a in agents] == ["lead", "tester", "coder", "reviewer"]


# --- lead: plan validation and retry ---------------------------------------------

def test_lead_is_read_only_and_offers_submit_plan(stats_repo: Path):
    llm = ScriptedLLM([submit_plan(VALID_PLAN)])
    run(build_lead(repo=stats_repo, settings=settings(), llm=llm))
    names = [t["function"]["name"] for t in llm.tools_sent[0]]
    assert names == ["search_code", "read_file", "list_dir", "submit_plan", "finish"]
    # Nested Subtask schema is inlined rather than referenced.
    params = llm.tools_sent[0][3]["function"]["parameters"]
    assert "$ref" not in str(params) and "$defs" not in params
    assert params["properties"]["subtasks"]["items"]["properties"]["role"]["enum"] == ["tester", "coder"]


def test_invalid_plan_is_sent_back_and_retried(stats_repo: Path):
    bad = {**VALID_PLAN, "subtasks": [{**VALID_PLAN["subtasks"][1], "role": "designer"}]}
    llm = ScriptedLLM([reply(("search_code", {"pattern": "def mean"})), submit_plan(bad), submit_plan(VALID_PLAN)])
    result = run(build_lead(repo=stats_repo, settings=settings(), llm=llm))

    assert result.success and result.stop_reason == "finished"
    assert Plan.model_validate(result.output) == Plan.model_validate(VALID_PLAN)
    assert result.summary == VALID_PLAN["issue_summary"]
    feedback = tool_results(llm.requests[2])[-1]
    assert feedback.startswith("ERROR: submit_plan arguments are invalid: subtasks.0.role:")
    assert "(2 retries left)" in feedback


def test_lead_gives_up_after_two_retries(stats_repo: Path):
    llm = ScriptedLLM([submit_plan({"issue_summary": "x"})] * 3 + [submit_plan(VALID_PLAN)])
    result = run(build_lead(repo=stats_repo, settings=settings(), llm=llm))
    assert (result.success, result.stop_reason, result.output) == (False, "invalid_output", None)
    assert "failed validation 3 times" in result.summary
    assert len(llm.requests) == 3


def test_plan_written_as_json_text_is_accepted(stats_repo: Path):
    import json

    llm = ScriptedLLM([reply(content=f"```json\n{json.dumps(VALID_PLAN)}\n```")])
    result = run(build_lead(repo=stats_repo, settings=settings(), llm=llm))
    assert result.success
    assert result.output["subtasks"][1]["id"] == "c1"


def test_lead_cannot_finish_successfully_without_a_plan(stats_repo: Path):
    llm = ScriptedLLM([finish(summary="planned"), submit_plan(VALID_PLAN)])
    result = run(build_lead(repo=stats_repo, settings=settings(), llm=llm))
    assert result.success and result.output is not None
    assert "submit_plan" in tool_results(llm.requests[1])[-1]


# --- tester: write restriction and must-fail check --------------------------------

@pytest.mark.parametrize(
    "path,allowed",
    [
        ("tests/test_median.py", True),
        ("tests/conftest.py", True),
        ("pkg/tests/helpers.py", True),
        ("test_root.py", True),
        ("stats/core.py", False),
        ("stats/test_data.json", False),
        ("tests.py", False),
        ("setup.py", False),
    ],
)
def test_is_test_path(path, allowed):
    assert is_test_path(path) is allowed


def test_tester_write_guard_is_enforced_in_the_tool_layer(stats_repo: Path):
    original = (stats_repo / "stats" / "core.py").read_text()
    edit, _replace, _insert, write = write_tools(stats_repo, guard=tests_only)
    for tool, args in [
        (write, {"path": "stats/core.py", "content": "pwned"}),
        (write, {"path": "tests/../stats/core.py", "content": "pwned"}),
        (edit, {"path": "stats/core.py", "old": "def mean", "new": "def mean2"}),
    ]:
        with pytest.raises(WriteNotAllowed, match="not a test file"):
            asyncio.run(tool.invoke(args))
    assert (stats_repo / "stats" / "core.py").read_text() == original
    asyncio.run(write.invoke({"path": "tests/test_new.py", "content": "x = 1\n"}))
    assert (stats_repo / "tests" / "test_new.py").exists()


def test_tester_agent_gets_error_for_non_test_writes(stats_repo: Path):
    llm = ScriptedLLM([
        reply(("edit_file", {"path": "stats/core.py", "old": "def mean", "new": "def median"})),
        finish(success=False, summary="blocked"),
    ])
    run(build_tester(repo=stats_repo, settings=settings(), llm=llm))
    assert tool_results(llm.requests[1])[-1].startswith("ERROR: WriteNotAllowed: stats/core.py is not a test file")
    assert "def mean" in (stats_repo / "stats" / "core.py").read_text()


def test_tester_must_rewrite_tests_that_already_pass(stats_repo: Path):
    llm = ScriptedLLM([
        finish(summary="nothing written"),
        reply(("write_file", {"path": "tests/test_median.py", "content": PASSING_TESTS})),
        finish(summary="tests written"),
        reply(("write_file", {"path": "tests/test_median.py", "content": MEDIAN_TESTS})),
        reply(("run_tests", {"path": "tests/test_median.py"})),
        # The run above shows fail-first, so the tester is ended without calling finish.
    ])
    result = run(build_tester(repo=stats_repo, settings=settings(), llm=llm))

    assert result.success
    assert result.files_changed == ["tests/test_median.py"]
    results = tool_results(llm.requests[-1])
    assert results[0] == "ERROR: finish rejected: you have not written any test file (test_*.py) yet"
    assert results[2].startswith("ERROR: finish rejected: your new tests PASS without any fix")
    assert result.summary.startswith("tester: fail-first confirmed, auto-finished (FAILED (exit 1): 3 failed")
    assert result.steps_used == 5


@pytest.mark.parametrize(
    "content,accepted",
    [
        (MEDIAN_TESTS, True),
        # A missing name breaks collection; for a new feature that is a valid failure.
        ("from stats import median\n\n\ndef test_median():\n    assert median([1]) == 1\n", True),
        (PASSING_TESTS, False),
        ("def test_broken(:\n    pass\n", False),
        ("x = 1\n", False),
    ],
    ids=["fails", "import-error", "passes", "syntax-error", "no-tests"],
)
def test_failing_test_gate(stats_repo: Path, content, accepted):
    (stats_repo / "tests" / "test_new.py").write_text(content)
    gate = FailingTestGate(stats_repo, TEST_COMMAND, timeout=60)
    gate.record("tests/test_new.py")
    verdict = gate.check()
    assert (verdict is None) is accepted, verdict


# --- coder: tester files are read-only --------------------------------------------

def test_coder_cannot_edit_tester_files(stats_repo: Path):
    (stats_repo / "tests" / "test_median.py").write_text(MEDIAN_TESTS)
    llm = ScriptedLLM([
        reply(("edit_file", {"path": "tests/test_median.py", "old": "== 2.5", "new": "== 2"})),
        reply(("write_file", {"path": "./tests/../tests/test_median.py", "content": ""})),
        reply(("edit_file", {"path": "tests/test_core.py", "old": "def test_mean():", "new": "def test_mean():  # ok"})),
        finish(success=False, summary="stuck"),
    ])
    coder = build_coder(repo=stats_repo, settings=settings(), llm=llm, protected_files=["tests/test_median.py"])
    result = run(coder)

    results = tool_results(llm.requests[-1])
    for blocked in results[:2]:
        assert blocked.startswith("ERROR: WriteNotAllowed: tests/test_median.py was written by the tester agent")
    assert results[2] .startswith("edited tests/test_core.py at line 6;")  # other files are still editable
    assert (stats_repo / "tests" / "test_median.py").read_text() == MEDIAN_TESTS
    assert result.files_changed == ["tests/test_core.py"]


# --- snapshot diff ----------------------------------------------------------------

def test_diff_and_files_changed_come_from_the_snapshot(tmp_path: Path):
    repo = tmp_path / "repo"
    (repo / "pkg").mkdir(parents=True)
    (repo / "pkg" / "a.py").write_bytes(b"x = 1\ny = 2\n")
    (repo / "old.txt").write_bytes(b"bye\n")
    (repo / "blob.bin").write_bytes(b"\0\1")
    (repo / "same.py").write_text("unchanged\n")

    with Snapshot(repo) as snapshot:
        snapshot_dir = snapshot.path
        assert (snapshot_dir / "pkg" / "a.py").read_text() == "x = 1\ny = 2\n"
        (repo / "pkg" / "a.py").write_bytes(b"x = 1\ny = 3\n")
        (repo / "old.txt").unlink()
        (repo / "pkg" / "new.py").write_bytes(b"z = 0")
        (repo / "blob.bin").write_bytes(b"\0\2")
        (repo / "__pycache__").mkdir()
        (repo / "__pycache__" / "a.cpython-312.pyc").write_bytes(b"\0")
        (repo / "pkg" / "b.pyc").write_bytes(b"\0")

        assert snapshot.changed_files() == ["blob.bin", "old.txt", "pkg/a.py", "pkg/new.py"]
        changes = snapshot.diff()
    assert not snapshot_dir.exists()

    assert changes.files_changed == ["blob.bin", "old.txt", "pkg/a.py", "pkg/new.py"]
    assert changes.diff == (
        "Binary files a/blob.bin and b/blob.bin differ\n"
        "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n"
        "--- a/pkg/a.py\n+++ b/pkg/a.py\n@@ -1,2 +1,2 @@\n x = 1\n-y = 2\n+y = 3\n"
        "--- /dev/null\n+++ b/pkg/new.py\n@@ -0,0 +1 @@\n+z = 0\n\\ No newline at end of file\n"
    )


# --- solo (crew runs are covered in test_orchestrator.py) -------------------------------

def test_solo_mode_runs_only_the_coder(tmp_path: Path):
    from conftest import TOY_CALCULATOR

    repo = copy_toy(TOY_CALCULATOR, tmp_path)
    llm = ScriptedLLM({"coder": [
        reply(
            ("edit_file", {"path": "calculator/ops.py", "old": "return b - a", "new": "return a - b"}),
            ("edit_file", {"path": "calculator/ops.py", "old": "return a // b", "new": "return a / b"}),
            ("edit_file", {"path": "calculator/stats.py", "old": "len(values) - 1", "new": "len(values)"}),
        ),
        reply(("run_tests", {})),
        finish(summary="fixed"),
    ]})
    orchestrator = Orchestrator(repo=repo, settings=settings(), llm=llm)
    result = asyncio.run(orchestrator.run_solo("fix the calculator"))
    assert result.success and result.mode == "solo"
    assert list(result.agents) == ["coder"]
    assert result.files_changed == ["calculator/ops.py", "calculator/stats.py"]
    assert "+    return a - b" in result.diff


# --- milestone 2 fixes: tester creates only, lead targets new files, auto-finish, nudge -----

def test_tester_cannot_change_existing_test_files(stats_repo: Path):
    original = (stats_repo / "tests" / "test_core.py").read_text()
    llm = ScriptedLLM([
        reply(("edit_file", {"path": "tests/test_core.py", "old": "from stats import", "new": "from stats import median,"})),
        reply(("write_file", {"path": "tests/test_core.py", "content": MEDIAN_TESTS})),
        reply(("write_file", {"path": "tests/test_median.py", "content": PASSING_TESTS})),
        # Its own new file may be rewritten.
        reply(("write_file", {"path": "tests/test_median.py", "content": MEDIAN_TESTS})),
        finish(success=False, summary="stop"),
    ])
    run(build_tester(repo=stats_repo, settings=settings(), llm=llm))
    results = tool_results(llm.requests[-1])
    for refused in results[:2]:
        assert refused == (
            "ERROR: WriteNotAllowed: tests/test_core.py already exists; existing tests must not be changed; "
            "put new tests in a new file"
        )
    assert results[2].startswith("wrote") and results[3].startswith("wrote")
    assert (stats_repo / "tests" / "test_core.py").read_text() == original


def test_lead_plan_targeting_an_existing_test_file_is_rejected(stats_repo: Path):
    bad = {**VALID_PLAN, "subtasks": [{**VALID_PLAN["subtasks"][0], "files_hint": ["./tests/test_core.py"]}, VALID_PLAN["subtasks"][1]]}
    llm = ScriptedLLM([submit_plan(bad), submit_plan(VALID_PLAN)])
    result = run(build_lead(repo=stats_repo, settings=settings(), llm=llm))
    assert result.success
    feedback = tool_results(llm.requests[1])[-1]
    assert "tester subtask t1 targets the existing test file tests/test_core.py" in feedback
    assert "NEW test file" in feedback
    # Without a repo in the validation context the check is skipped.
    assert Plan.model_validate(bad).subtasks[0].files_hint == ["./tests/test_core.py"]


@pytest.mark.parametrize(
    "content",
    [MEDIAN_TESTS, "from stats import median\n\n\ndef test_median():\n    assert median([1]) == 1\n"],
    ids=["assertion-failure", "import-error"],
)
def test_tester_auto_finishes_on_fail_first(stats_repo: Path, content):
    llm = ScriptedLLM([
        reply(("write_file", {"path": "tests/test_median.py", "content": content})),
        reply(("run_tests", {"path": "tests/test_median.py"})),
    ])
    events = []
    result = run(build_tester(repo=stats_repo, settings=settings(), llm=llm, on_event=events.append))
    assert result.success and result.stop_reason == "finished" and result.steps_used == 2
    assert result.summary.startswith("tester: fail-first confirmed, auto-finished (FAILED")
    assert any(e.kind == "note" and e.summary.startswith("tester: fail-first confirmed, auto-finished") for e in events)


def test_tester_does_not_auto_finish_on_syntax_error_or_full_suite(stats_repo: Path):
    # Parses (so the write guard accepts it) but fails to compile: a SyntaxError at collection.
    broken = "import stats\n\n\ndef test_median():\n    break\n"
    llm = ScriptedLLM([
        reply(("write_file", {"path": "tests/test_median.py", "content": broken})),
        reply(("run_tests", {"path": "tests/test_median.py"})),
        reply(("write_file", {"path": "tests/test_median.py", "content": MEDIAN_TESTS})),
        reply(("run_tests", {})),  # the full suite is not "only the new files"
        reply(("run_tests", {"path": "tests/test_median.py::test_median_odd"})),
    ])
    result = run(build_tester(repo=stats_repo, settings=settings(), llm=llm))
    results = results_as_sent(llm)
    assert results[1].startswith("FAILED (exit 2)") and "SyntaxError" in results[1]
    assert results[3].startswith("FAILED (exit 1): 3 failed, 6 passed")
    assert result.success and result.steps_used == 5
    assert "FAILED (exit 1): 1 failed" in result.summary


def test_coder_is_nudged_to_run_tests(stats_repo: Path):
    from patchwork.agents.coder import TestGate

    llm = ScriptedLLM([
        reply(("edit_file", {"path": "stats/core.py", "old": "    return max(values) - min(values)", "new": MEDIAN_IMPL})),
        *[reply(("search_code", {"pattern": f"def {name}"})) for name in ("mean", "mode", "data_range", "median", "x")],
        reply(("run_tests", {})),
        *[reply(("search_code", {"pattern": f"import {name}"})) for name in ("a", "b", "c", "d", "e")],
        finish(),
    ])
    coder = build_coder(repo=stats_repo, settings=settings(max_steps_per_agent=14), llm=llm)
    result = run(coder)
    assert result.success
    nudged = [i for i, request in enumerate(llm.requests) if request[-1]["content"] == TestGate.NUDGE]
    # Edit at step 1, no tests in steps 2-6: the note goes into step 7's request only.
    assert nudged == [6]


def test_coder_early_give_up_is_rejected_once(stats_repo: Path):
    from patchwork.agents.coder import TestGate

    llm = ScriptedLLM([finish(success=False, summary="no idea"), finish(success=False, summary="really stuck")])
    result = run(build_coder(repo=stats_repo, settings=settings(), llm=llm))
    assert (result.success, result.summary, result.steps_used) == (False, "really stuck", 2)
    assert tool_results(llm.requests[1])[-1] == f"ERROR: finish rejected: {TestGate.GIVE_UP_TOO_EARLY}"

    # Giving up in prose (two plain-text replies) is caught the same way.
    llm = ScriptedLLM([reply(content="I can't."), reply(content="Giving up."), reply(content="Hm."), reply(content="Done.")])
    result = run(build_coder(repo=stats_repo, settings=settings(), llm=llm))
    assert (result.success, result.summary, result.steps_used) == (False, "Done.", 4)
    assert llm.requests[2][-1]["content"] == TestGate.GIVE_UP_TOO_EARLY

    # After an attempt (here: a test run), giving up is allowed straight away.
    llm = ScriptedLLM([reply(("run_tests", {})), finish(success=False, summary="cannot")])
    result = run(build_coder(repo=stats_repo, settings=settings(), llm=llm))
    assert (result.success, result.summary, result.steps_used) == (False, "cannot", 2)


def test_coder_nudge_waits_5_steps_after_the_first_untested_edit(stats_repo: Path):
    from patchwork.agents.coder import TestGate

    explore = [reply(("search_code", {"pattern": f"exploring {i}"})) for i in range(6)]
    llm = ScriptedLLM([
        *explore,  # steps 1-6: no edits, no tests -> no nudge
        reply(("insert_lines", {"path": "stats/core.py", "after_line": -1, "text": "\n\n" + MEDIAN_IMPL.split("\n\n\n", 1)[1]})),
        *[reply(("search_code", {"pattern": f"after edit {i}"})) for i in range(5)],  # steps 8-12
        reply(("write_file", {"path": "stats/__init__.py", "content": STATS_INIT})),  # step 13: the nudged turn
        reply(("run_tests", {})),
        finish(summary="added median"),
    ])
    result = run(build_coder(repo=stats_repo, settings=settings(max_steps_per_agent=20), llm=llm))
    assert result.success
    nudged = [i + 1 for i, request in enumerate(llm.requests) if request[-1]["content"] == TestGate.NUDGE]
    assert nudged == [13]  # first edit at step 7; steps 8-12 without tests
    insert_result = tool_results(llm.requests[7])[-1]
    assert insert_result.startswith("inserted 11 line(s) into stats/core.py after line 25; it now reads:")
    assert "def median(values):" in (stats_repo / "stats" / "core.py").read_text()
