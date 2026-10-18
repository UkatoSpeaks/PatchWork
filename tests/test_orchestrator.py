"""Milestone 3: the crew on git worktrees, retries, events and replay.

Real git in temp dirs; the LLM is scripted. Each role has its own model name
so ScriptedLLM can route responses (coder retries continue the coder queue).
"""

import asyncio
import json
from pathlib import Path

import pytest

from patchwork.config import Settings
from patchwork.events import Event, EventBus, JsonlWriter, read_events
from patchwork.orchestrator import Orchestrator
from patchwork.render import CliRenderer, ListSink
from patchwork.workspace import MergeConflict, Workspace, WorkspaceError, ensure_repo, git

from conftest import TOY_STATS, copy_toy
from scripted import ScriptedLLM, finish, reply, tool_results
from test_crew import MEDIAN_IMPL, MEDIAN_TESTS, STATS_INIT, VALID_PLAN, submit_plan, submit_review

pytestmark = pytest.mark.usefixtures("git_env")

TEST_COMMAND = "python -m pytest -q --tb=short -p no:cacheprovider"
MEDIAN_FUNC = "\n\n" + MEDIAN_IMPL.split("\n\n\n", 1)[1]  # just the new function
BLOCKER = {"severity": "blocker", "file": "stats/core.py", "description": "median() does not reject non-numeric input"}


def settings(**overrides) -> Settings:
    values = dict(
        lead_model="lead", tester_model="tester", coder_model="coder", reviewer_model="reviewer",
        max_steps_per_agent=10, test_command=TEST_COMMAND,
    )
    return Settings(_env_file=None, **{**values, **overrides})


@pytest.fixture
def stats_git(tmp_path: Path) -> Path:
    repo = copy_toy(TOY_STATS, tmp_path)
    ensure_repo(repo, init_git=True)
    return repo


def lead_script():
    return [reply(("search_code", {"pattern": "def mean"})), submit_plan(VALID_PLAN)]


def qa_script():
    """The tester's script (not named test_* so pytest does not collect it)."""
    return [
        reply(("write_file", {"path": "tests/test_median.py", "content": MEDIAN_TESTS})),
        reply(("run_tests", {"path": "tests/test_median.py"})),  # fail-first -> auto-finish
    ]


def coder_script(export: bool = True):
    steps = [reply(("insert_lines", {"path": "stats/core.py", "after_line": -1, "text": MEDIAN_FUNC}))]
    if export:
        steps.append(reply(("write_file", {"path": "stats/__init__.py", "content": STATS_INIT})))
    return steps + [reply(("run_tests", {})), finish(summary="added median")]


def crew(repo: Path, scripts: dict, **kwargs):
    """Run the crew; returns (result, events, llm, rendered lines)."""
    llm = ScriptedLLM(scripts)
    bus = EventBus()
    events: list[Event] = []
    sink = ListSink()
    bus.subscribe(events.append)
    bus.subscribe(CliRenderer(sink))
    if "writer_dir" in kwargs:
        bus.subscribe(JsonlWriter(kwargs.pop("writer_dir")))
    overrides = kwargs.pop("settings", {})
    orchestrator = Orchestrator(repo=repo, settings=settings(**overrides), llm=llm, bus=bus, **kwargs)
    result = asyncio.run(orchestrator.run(VALID_PLAN["issue_summary"]))
    return result, events, llm, sink.lines


def of(events, type_, agent=None):
    return [e for e in events if e.type == type_ and (agent is None or e.agent == agent)]


def worktrees(repo: Path) -> list[str]:
    return [line for line in git(repo, "worktree", "list", "--porcelain").stdout.splitlines() if line.startswith("worktree ")]


def branches(repo: Path) -> list[str]:
    return sorted(git(repo, "branch", "--format=%(refname:short)").stdout.split())


def tree_bytes(repo: Path) -> dict[str, bytes]:
    return {
        p.relative_to(repo).as_posix(): p.read_bytes()
        for p in repo.rglob("*")
        if p.is_file() and ".git" not in p.relative_to(repo).parts
    }


# --- repository checks ------------------------------------------------------------------

def test_init_git_on_a_non_repo(tmp_path: Path):
    repo = copy_toy(TOY_STATS, tmp_path)
    with pytest.raises(WorkspaceError, match="not a git repository.*--init-git"):
        ensure_repo(repo)
    ensure_repo(repo, init_git=True)
    assert git(repo, "status", "--porcelain").stdout == ""
    assert "stats/core.py" in git(repo, "ls-files").stdout
    assert git(repo, "log", "--format=%s").stdout.strip() == "Initial commit (patchwork --init-git)"


def test_dirty_repo_is_refused(stats_git: Path):
    (stats_git / "stats" / "core.py").write_text("# changed\n", encoding="utf-8")
    with pytest.raises(WorkspaceError, match="uncommitted changes; commit or stash them first"):
        ensure_repo(stats_git)
    result, events, llm, _ = crew(stats_git, {"lead": [], "tester": [], "coder": [], "reviewer": []})
    assert not result.success and "uncommitted changes" in result.error
    assert llm.requests == []
    assert [e.type for e in events] == ["run_started", "run_finished"]


def test_non_repo_without_init_git_stops_with_a_clear_error(tmp_path: Path):
    repo = copy_toy(TOY_STATS, tmp_path)
    result, *_ = crew(repo, {"lead": []})
    assert "not a git repository" in result.error and "--init-git" in result.error
    assert not (repo / ".git").exists()


# --- the full flow ------------------------------------------------------------------------

def test_full_parallel_run(stats_git: Path):
    before = tree_bytes(stats_git)
    head = git(stats_git, "rev-parse", "HEAD").stdout.strip()
    result, events, llm, _ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": [submit_review()]},
    )

    assert result.success, result.error or result.failed_agent
    assert result.tests_passed and result.verdict.approved and result.retries == 0
    assert result.tests_written == ["tests/test_median.py"]
    assert result.files_changed == ["stats/__init__.py", "stats/core.py", "tests/test_median.py"]
    assert "+def median(values):" in result.diff and "+++ b/tests/test_median.py" in result.diff
    assert result.result_branch == f"patchwork/{result.run_id}/result"
    assert result.base_commit == head

    # The diff is what git says the result branch changed.
    assert result.diff == git(stats_git, "diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "HEAD",
                              result.result_branch).stdout
    # The user's working tree, HEAD and status are untouched.
    assert tree_bytes(stats_git) == before
    assert git(stats_git, "rev-parse", "HEAD").stdout.strip() == head
    assert git(stats_git, "status", "--porcelain").stdout == ""
    # Worktrees removed; only the result branch is kept.
    assert len(worktrees(stats_git)) == 1
    assert branches(stats_git) == ["main", result.result_branch]

    # The coder never saw the tester's tests: they did not exist in its worktree.
    coder_task = llm.requests_for("coder")[0][1]["content"]
    assert "test_median" not in coder_task
    # Durations per phase and agent.
    assert set(result.phases) == {"plan", "implement", "integrate", "verify", "review"}
    assert all(run.duration_s >= 0 for run in result.runs)
    assert [run.label for run in result.runs][0] == "lead"


def test_tester_and_coder_really_run_concurrently(stats_git: Path):
    result, events, *_ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": [submit_review()]},
    )
    assert result.success
    order = [(e.type, e.agent) for e in events if e.type in ("agent_started", "agent_finished")]
    started = {agent: order.index(("agent_started", agent)) for agent in ("tester", "coder")}
    finished = {agent: order.index(("agent_finished", agent)) for agent in ("tester", "coder")}
    assert max(started.values()) < min(finished.values())  # both started before either finished
    implement = of(events, "phase_started")[1]
    assert implement.payload == {"phase": "implement", "parallel": True}


def test_sequential_gives_the_same_result(tmp_path: Path):
    results = {}
    for mode in ("parallel", "sequential"):
        repo = copy_toy(TOY_STATS, tmp_path / mode)
        ensure_repo(repo, init_git=True)
        results[mode] = crew(
            repo,
            {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": [submit_review()]},
            sequential=mode == "sequential",
        )
    (par, _, _, _), (seq, seq_events, _, _) = results["parallel"], results["sequential"]
    assert par.success and seq.success and seq.sequential and not par.sequential
    assert seq.files_changed == par.files_changed
    assert seq.diff == par.diff
    order = [(e.type, e.agent) for e in seq_events if e.type in ("agent_started", "agent_finished")]
    assert order.index(("agent_finished", "tester")) < order.index(("agent_started", "coder"))


def test_event_sequence_for_a_full_run(stats_git: Path, tmp_path: Path):
    result, events, *_ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": [submit_review()]},
        sequential=True,  # deterministic order
    )
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert {e.run_id for e in events} == {result.run_id}
    milestones = [
        (e.agent, e.type, e.payload.get("phase"))
        for e in events
        if e.type not in ("llm_call", "tool_called", "tool_result", "note")
    ]
    assert milestones == [
        ("orchestrator", "run_started", None),
        ("orchestrator", "phase_started", "plan"),
        ("lead", "agent_started", None),
        ("lead", "agent_finished", None),
        ("orchestrator", "phase_finished", "plan"),
        ("orchestrator", "phase_started", "implement"),
        ("tester", "agent_started", None),
        ("tester", "agent_finished", None),
        ("coder", "agent_started", None),
        ("coder", "agent_finished", None),
        ("orchestrator", "phase_finished", "implement"),
        ("orchestrator", "phase_started", "integrate"),
        ("orchestrator", "merge", None),
        ("orchestrator", "merge", None),
        ("orchestrator", "phase_finished", "integrate"),
        ("orchestrator", "phase_started", "verify"),
        ("orchestrator", "tests_run", None),
        ("orchestrator", "phase_finished", "verify"),
        ("orchestrator", "phase_started", "review"),
        ("reviewer", "agent_started", None),
        ("reviewer", "review_verdict", None),
        ("reviewer", "agent_finished", None),
        ("orchestrator", "phase_finished", "review"),
        ("orchestrator", "run_finished", None),
    ]
    # Agent-internal events are attributed to their agent.
    assert {e.agent for e in of(events, "tool_called")} == {"lead", "tester", "coder"}
    assert [e.payload["text"] for e in of(events, "note", "tester") if e.payload["kind"] == "note"][0].startswith(
        "tester: fail-first confirmed, auto-finished"
    )
    finished = of(events, "agent_finished", "tester")[0].payload
    assert finished["tests_written"] == ["tests/test_median.py"] and finished["duration_s"] >= 0
    assert of(events, "run_finished")[0].payload["result"]["success"] is True


# --- retries --------------------------------------------------------------------------------

def test_failing_suite_triggers_a_coder_retry_with_the_failure(stats_git: Path):
    retry = [
        reply(("edit_file", {"path": "tests/test_median.py", "old": "== 2.5", "new": "== 2"})),  # protected
        reply(("write_file", {"path": "stats/__init__.py", "content": STATS_INIT})),
        reply(("run_tests", {})),
        finish(summary="exported median"),
    ]
    result, events, llm, _ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(export=False) + retry,
         "reviewer": [submit_review()]},
    )
    assert result.success and result.retries == 1
    assert [e.payload["passed"] for e in of(events, "tests_run")] == [False, True]
    started = of(events, "retry_started")[0].payload
    assert started["reason"] == "tests" and "has no attribute 'median'" in started["feedback"]

    retry_task = llm.requests_for("coder")[len(coder_script(export=False))][1]["content"]
    assert "The full test suite fails in the merged result" in retry_task
    assert "has no attribute 'median'" in retry_task
    assert "+def median(values):" in retry_task  # the current diff
    assert "- tests/test_median.py" in retry_task  # read-only list
    assert "written by the tester agent and is read-only" in tool_results(llm.requests_for("coder")[-1])[0]
    assert [run.label for run in result.runs if run.agent == "coder"] == ["coder", "coder (retry 1: tests)"]
    assert "stats/__init__.py" in result.files_changed
    # The retry's change was committed to the result branch.
    log = git(stats_git, "log", "--format=%s", result.result_branch).stdout
    assert "coder retry 1 (tests)" in log


def test_review_blocker_triggers_a_retry_then_a_second_review(stats_git: Path):
    retry = [
        reply(("edit_file", {"path": "stats/core.py", "old": "    ordered = sorted(values)",
                             "new": "    ordered = sorted(values)  # copy; input is not modified"})),
        reply(("run_tests", {})),
        finish(summary="addressed review"),
    ]
    result, events, llm, lines = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script() + retry,
         "reviewer": [submit_review(approved=False, issues=[BLOCKER], summary="Needs work."), submit_review()]},
    )
    assert result.success and result.retries == 1
    assert [e.payload["approved"] for e in of(events, "review_verdict")] == [False, True]
    assert of(events, "retry_started")[0].payload["reason"] == "review"
    retry_task = llm.requests_for("coder")[len(coder_script())][1]["content"]
    assert "[blocker] stats/core.py: median() does not reject" in retry_task
    assert len(of(events, "tests_run")) == 2  # suite re-run after the retry
    assert [run.label for run in result.runs if run.agent == "reviewer"] == ["reviewer", "reviewer (round 2)"]
    assert "# copy; input is not modified" in result.diff


def test_retry_cap_is_respected(stats_git: Path):
    retry = [reply(("run_tests", {})), finish(summary="tried")]
    result, events, *_ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script() + retry,
         "reviewer": [submit_review(approved=False, issues=[BLOCKER], summary="No.")] * 2},
        max_retries=1,
    )
    assert not result.success and result.failed_agent is None
    assert result.retries == 1 and result.tests_passed and not result.verdict.approved
    assert len(of(events, "retry_started")) == 1 and len(of(events, "review_verdict")) == 2
    assert of(events, "note", "orchestrator")[-1].payload["kind"] == "retry_limit"


def test_suite_failure_with_no_retries_left(stats_git: Path):
    result, events, *_ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(export=False), "reviewer": []},
        max_retries=0,
    )
    assert not result.success and result.tests_passed is False and result.retries == 0
    assert of(events, "agent_started", "reviewer") == []


# --- failure and cleanup ----------------------------------------------------------------------

def test_worktrees_are_cleaned_up_after_an_agent_failure(stats_git: Path):
    before = tree_bytes(stats_git)
    result, events, llm, lines = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(),
         "coder": [finish(success=False, summary="no idea"), finish(success=False, summary="stuck")], "reviewer": []},
    )
    assert (result.success, result.failed_agent) == (False, "coder")
    assert of(events, "phase_started")[-1].payload["phase"] == "implement"  # stopped before integrate
    assert len(worktrees(stats_git)) == 1
    # The tester's branch has its test file, so it is kept; the coder committed nothing,
    # so its branch is deleted. No result branch.
    tester_branch = f"patchwork/{result.run_id}/tester"
    assert branches(stats_git) == ["main", tester_branch]
    assert result.kept_branches == [tester_branch]
    assert result.result_branch is None and result.diff == ""
    assert tree_bytes(stats_git) == before
    base = result.base_commit[:12]
    assert f"    git log --oneline {base}..{tester_branch}" in lines
    assert f"Delete them:   git branch -D {tester_branch}" in lines
    assert "reason:        finished: stuck" in lines


def test_sequential_stops_before_the_coder_when_the_tester_fails(stats_git: Path):
    tester = [reply(("write_file", {"path": "tests/test_median.py", "content": MEDIAN_TESTS})),
              finish(success=False, summary="cannot write failing tests")]
    result, events, llm, _ = crew(
        stats_git, {"lead": lead_script(), "tester": tester, "coder": coder_script(), "reviewer": []},
        sequential=True,
    )
    assert (result.success, result.failed_agent) == (False, "tester")
    assert of(events, "agent_started", "coder") == [] and llm.requests_for("coder") == []
    assert of(events, "note", "orchestrator")[-1].payload["text"] == "the tester failed; not starting the coder"
    # Failed run: the tester branch has a commit and is kept; no coder branch was created.
    assert branches(stats_git) == ["main", f"patchwork/{result.run_id}/tester"]
    assert len(worktrees(stats_git)) == 1


def test_parallel_failure_cancels_the_sibling(stats_git: Path):
    coder = [reply(("list_dir", {"path": "."})) for _ in range(9)] + [finish(summary="never reached")]
    result, events, llm, _ = crew(
        stats_git,
        {"lead": lead_script(), "tester": [finish(success=False, summary="cannot test this")], "coder": coder,
         "reviewer": []},
    )
    assert (result.success, result.failed_agent) == (False, "tester")
    # The coder was stopped part-way, recorded as cancelled, and cleaned up after.
    assert len(llm.requests_for("coder")) < len(coder)
    [coder_done] = of(events, "agent_finished", "coder")
    assert (coder_done.payload["success"], coder_done.payload["stop_reason"]) == (False, "cancelled")
    assert [r.result.stop_reason for r in result.runs if r.agent == "coder"] == ["cancelled"]
    assert "the tester failed; cancelling the coder" in [e.payload["text"] for e in of(events, "note", "orchestrator")]
    assert of(events, "phase_started")[-1].payload["phase"] == "implement"
    assert len(worktrees(stats_git)) == 1 and branches(stats_git) == ["main"]  # neither committed anything


def test_failed_run_keeps_the_result_branch_with_inspect_commands(stats_git: Path):
    retry = [reply(("run_tests", {})), finish(summary="tried")]
    result, _, _, lines = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script() + retry,
         "reviewer": [submit_review(approved=False, issues=[BLOCKER], summary="No.")] * 2},
        max_retries=1,
    )
    assert not result.success
    # A failed run keeps every branch with commits, merged or not.
    prefix = f"patchwork/{result.run_id}"
    assert result.kept_branches == [f"{prefix}/tester", f"{prefix}/coder", f"{prefix}/result"]
    assert result.result_branch == f"{prefix}/result" and "+def median(values):" in result.diff
    assert branches(stats_git) == sorted(["main", *result.kept_branches])
    assert len(worktrees(stats_git)) == 1
    for branch in result.kept_branches:
        assert f"    git diff {result.base_commit[:12]} {branch}" in lines


def test_daily_limit_fallback_is_recorded_in_the_result_and_table(stats_git: Path):
    from datetime import datetime

    from patchwork.llm import DailyLimitReached

    exhausted = DailyLimitReached("lead", "on tokens per day (TPD): Limit 200000", 60.0, datetime(2026, 1, 1, 9, 0),
                                  "tokens per day (TPD)")
    result, events, llm, lines = crew(
        stats_git,
        {"lead": [exhausted], "lead-backup": lead_script(), "tester": qa_script(), "coder": coder_script(),
         "reviewer": [submit_review()]},
        settings={"lead_fallbacks": "lead-backup"},
    )
    assert result.success
    lead_run = result.runs[0]
    assert (lead_run.model, lead_run.result.models_used) == ("lead", ["lead", "lead-backup"])
    assert {r.agent: r.result.models_used for r in result.runs[1:]} == {
        "tester": ["tester"], "coder": ["coder"], "reviewer": ["reviewer"]}
    assert any(line.startswith("lead      lead -> lead-backup") for line in lines)
    assert "lead    | [step  1] daily limit reached on lead, switching to lead-backup" in lines


def test_final_table_shows_todays_usage(stats_git: Path, tmp_path: Path):
    from patchwork.usage import UsageStore

    store = UsageStore(tmp_path / "usage.json")
    store.note_reported("groq/openai/gpt-oss-120b", used_tokens=152400, tokens_per_day=200000, requests_per_day=1000)
    llm = ScriptedLLM({"lead": [finish(success=False, summary="cannot plan")]})
    llm.usage = store
    sink = ListSink()
    bus = EventBus()
    bus.subscribe(CliRenderer(sink))
    result = asyncio.run(Orchestrator(repo=stats_git, settings=settings(), llm=llm, bus=bus).run("x"))
    assert result.usage_today["groq/openai/gpt-oss-120b"]["tokens"] == 152400
    assert "  groq/openai/gpt-oss-120b today: 152,400 / 200,000 tokens, 0 / 1,000 requests" in sink.lines


def test_merge_conflict_stops_with_the_files_and_cleans_up(stats_git: Path, monkeypatch):
    def conflict(self, into, name):
        raise MergeConflict(self.branch(name), ["stats/core.py"])

    monkeypatch.setattr(Workspace, "merge", conflict)
    result, events, *_ = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": []},
    )
    assert not result.success and "conflicted in: stats/core.py" in result.error
    assert of(events, "merge")[0].payload["ok"] is False
    assert len(worktrees(stats_git)) == 1


def test_lead_failure_creates_no_worktrees(stats_git: Path):
    result, events, *_ = crew(stats_git, {"lead": [finish(success=False, summary="cannot plan")]})
    assert result.failed_agent == "lead"
    assert len(worktrees(stats_git)) == 1 and branches(stats_git) == ["main"]


# --- events on disk and replay ------------------------------------------------------------------

def test_replay_reproduces_the_cli_output(stats_git: Path, tmp_path: Path):
    run_dir = tmp_path / "runs" / "x"
    result, events, _, live_lines = crew(
        stats_git,
        {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": [submit_review()]},
        writer_dir=run_dir,
    )
    replayed = ListSink()
    renderer = CliRenderer(replayed)
    for event in read_events(run_dir / "events.jsonl"):
        renderer(event)
    assert replayed.lines == live_lines
    assert any(line.startswith("tester  | [step  1] write_file(") for line in live_lines)
    assert f"Apply it:      git merge {result.result_branch}" in live_lines
    assert json.loads((run_dir / "result.json").read_text())["success"] is True


def test_cli_run_and_replay(stats_git: Path, tmp_path: Path, monkeypatch):
    from typer.testing import CliRunner

    import patchwork.cli as cli

    scripts = {"lead": lead_script(), "tester": qa_script(), "coder": coder_script(), "reviewer": [submit_review()]}
    monkeypatch.setattr(cli, "LLMClient", lambda **kw: ScriptedLLM(scripts))
    monkeypatch.setattr(cli, "RUNS_DIR", tmp_path / "runs")
    env = {"LEAD_MODEL": "lead", "TESTER_MODEL": "tester", "CODER_MODEL": "coder", "REVIEWER_MODEL": "reviewer",
           "TEST_COMMAND": TEST_COMMAND}
    runner = CliRunner()
    live = runner.invoke(cli.app, ["run", "--repo", str(stats_git), "--issue", "Add median()"], env=env)
    assert live.exit_code == 0, live.output
    [log] = (tmp_path / "runs").glob("*/events.jsonl")
    replay = runner.invoke(cli.app, ["replay", str(log)])
    assert replay.exit_code == 0
    assert replay.output in live.output  # live output adds only the trailing event-log hint
    assert "Patchwork crew (parallel)" in replay.output and "success:       True" in replay.output
