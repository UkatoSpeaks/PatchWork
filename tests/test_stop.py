"""Stopping a run: Orchestrator.stop, the stop file, `patchwork stop` and the API.

Real git in temp dirs; the LLM is scripted. One role's model hangs once its
script runs out, so the test can stop the run while that agent is at work.
"""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

import patchwork.cli as cli
from patchwork.events import Event, EventBus, JsonlWriter
from patchwork.launcher import Launch, Launcher
from patchwork.orchestrator import Orchestrator
from patchwork.runlock import LOCK_NAME, request_stop, stop_path, stop_requested
from patchwork.server import create_app

from conftest import TOY_STATS, copy_toy
from scripted import ScriptedLLM, finish, reply
from test_orchestrator import branches, coder_script, lead_script, qa_script, settings, stats_git, worktrees  # noqa: F401
from test_crew import VALID_PLAN

pytestmark = pytest.mark.usefixtures("git_env")
ISSUE = VALID_PLAN["issue_summary"]


class HangingLLM(ScriptedLLM):
    """Like ScriptedLLM, but a call for ``hang`` once its script is used up
    waits forever (like a long rate-limit wait), after setting ``waiting``."""

    def __init__(self, scripts, hang: str):
        super().__init__(scripts)
        self.hang = hang
        self.waiting = asyncio.Event()

    async def complete(self, model, messages, tools=None, **kwargs):
        if model == self.hang and not self.scripts[model]:
            self.waiting.set()
            await asyncio.Future()
        return await super().complete(model, messages, tools, **kwargs)


def make(repo: Path, scripts: dict, hang: str, writer_dir: Path | None = None, **kwargs):
    llm = HangingLLM(scripts, hang)
    bus = EventBus()
    events: list[Event] = []
    bus.subscribe(events.append)
    if writer_dir is not None:
        bus.subscribe(JsonlWriter(writer_dir / bus.run_id))
    orchestrator = Orchestrator(repo=repo, settings=settings(), llm=llm, bus=bus, **kwargs)
    return orchestrator, llm, events


def stop_while_waiting(orchestrator: Orchestrator, llm: HangingLLM, solo: bool = False):
    async def main():
        task = asyncio.create_task(orchestrator.run_solo(ISSUE) if solo else orchestrator.run(ISSUE))
        await asyncio.wait_for(llm.waiting.wait(), 10)
        assert orchestrator.stop("test stop")
        assert not orchestrator.stop("again")  # once is enough
        return await asyncio.wait_for(task, 10)

    return asyncio.run(main())


def of(events, type_, agent=None):
    return [e for e in events if e.type == type_ and (agent is None or e.agent == agent)]


# --- the orchestrator -------------------------------------------------------------------


def test_stop_during_the_parallel_implement_phase_keeps_the_work_and_cleans_up(stats_git: Path):
    # The coder makes one edit, then hangs; the tester finishes meanwhile.
    coder = coder_script()[:1]
    orchestrator, llm, events = make(stats_git, {"lead": lead_script(), "tester": qa_script(), "coder": coder,
                                                 "reviewer": []}, hang="coder")
    result = stop_while_waiting(orchestrator, llm)

    assert (result.success, result.stopped, result.error) == (False, True, "stopped: test stop")
    assert result.failed_agent is None
    [coder_done] = of(events, "agent_finished", "coder")
    assert (coder_done.payload["stop_reason"], coder_done.payload["committed"]) == ("stopped", True)
    assert coder_done.payload["summary"] == "stopped: test stop"
    assert [a.outcome for a in result.attempts] == ["cancelled"]
    assert "stopping: test stop" in [e.payload["text"] for e in of(events, "note", "orchestrator")]
    # Nothing after implement ran, and the run still ended with run_finished.
    assert [e.payload["phase"] for e in of(events, "phase_started")] == ["plan", "implement"]
    assert events[-1].type == "run_finished" and events[-1].payload["result"]["stopped"] is True
    # Worktrees removed; the branches with commits are kept.
    prefix = f"patchwork/{result.run_id}"
    assert len(worktrees(stats_git)) == 1
    assert result.kept_branches == [f"{prefix}/tester", f"{prefix}/coder"]
    assert branches(stats_git) == sorted(["main", *result.kept_branches])


def test_stop_during_the_plan_creates_no_worktrees(stats_git: Path):
    orchestrator, llm, events = make(stats_git, {"lead": [], "tester": [], "coder": [], "reviewer": []}, hang="lead")
    result = stop_while_waiting(orchestrator, llm)
    assert result.stopped and result.plan is None
    [lead_done] = of(events, "agent_finished", "lead")
    assert lead_done.payload["stop_reason"] == "stopped"
    assert branches(stats_git) == ["main"] and len(worktrees(stats_git)) == 1


def test_stop_during_the_review_keeps_the_result_branch(stats_git: Path):
    orchestrator, llm, events = make(stats_git, {"lead": lead_script(), "tester": qa_script(),
                                                 "coder": coder_script(), "reviewer": []}, hang="reviewer")
    result = stop_while_waiting(orchestrator, llm)
    assert result.stopped and result.tests_passed is True and result.verdict is None
    assert result.result_branch == f"patchwork/{result.run_id}/result" and "+def median(values):" in result.diff
    assert of(events, "agent_finished", "reviewer")[0].payload["stop_reason"] == "stopped"
    assert len(worktrees(stats_git)) == 1


def test_stop_in_sequential_mode(stats_git: Path):
    orchestrator, llm, events = make(stats_git, {"lead": lead_script(), "tester": qa_script()[:1], "coder": [],
                                                 "reviewer": []}, hang="tester", sequential=True)
    result = stop_while_waiting(orchestrator, llm)
    assert result.stopped and not of(events, "agent_started", "coder")
    assert result.kept_branches == [f"patchwork/{result.run_id}/tester"]  # its test file, committed


def test_a_stop_before_the_run_starts_ends_it_at_once(stats_git: Path):
    orchestrator, _, events = make(stats_git, {"lead": [], "tester": [], "coder": [], "reviewer": []}, hang="lead")
    assert orchestrator.stop("early")
    result = asyncio.run(orchestrator.run(ISSUE))
    assert result.stopped and result.error == "stopped: early" and not result.runs
    assert events[-1].type == "run_finished" and branches(stats_git) == ["main"]
    assert not orchestrator.stop("after the end")


def test_stop_a_solo_run(tmp_path: Path):
    repo = copy_toy(TOY_STATS, tmp_path)
    edit = reply(("write_file", {"path": "NOTES.md", "content": "partial\n"}))
    orchestrator, llm, events = make(repo, {"coder": [edit]}, hang="coder")
    result = stop_while_waiting(orchestrator, llm, solo=True)
    assert result.stopped and result.files_changed == ["NOTES.md"]
    assert of(events, "agent_finished", "coder")[0].payload["stop_reason"] == "stopped"


def test_a_cancellation_from_outside_still_cleans_up_and_propagates(stats_git: Path):
    orchestrator, llm, events = make(stats_git, {"lead": lead_script(), "tester": qa_script(), "coder": [],
                                                 "reviewer": []}, hang="coder")

    async def main():
        task = asyncio.create_task(orchestrator.run(ISSUE))
        await asyncio.wait_for(llm.waiting.wait(), 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert events[-1].type == "run_finished" and events[-1].payload["result"]["stopped"] is True
    assert len(worktrees(stats_git)) == 1


# --- the stop file and the CLI ----------------------------------------------------------------


def test_the_run_stops_when_its_stop_file_appears(stats_git: Path, tmp_path: Path, monkeypatch):
    monkeypatch.setattr(cli, "STOP_POLL_S", 0.01)
    runs = tmp_path / "runs"
    orchestrator, llm, _ = make(stats_git, {"lead": [], "tester": [], "coder": [], "reviewer": []}, hang="lead",
                                writer_dir=runs)

    async def main():
        task = asyncio.create_task(cli.run_stoppable(orchestrator, ISSUE, False, runs, orchestrator.run_id))
        await asyncio.wait_for(llm.waiting.wait(), 10)
        request_stop(runs, orchestrator.run_id, by="test")
        return await asyncio.wait_for(task, 10)

    result = asyncio.run(main())
    assert result.stopped and result.error == "stopped: stop requested"
    assert json.loads(stop_path(runs, result.run_id).read_text())["by"] == "test"


def test_patchwork_stop_asks_the_current_run(tmp_path: Path):
    runs = tmp_path / "runs"
    runs.mkdir()
    invoke = lambda *args: CliRunner().invoke(cli.app, ["stop", *args, "--runs-dir", str(runs)])

    result = invoke()
    assert result.exit_code == 1 and "No run is going." in result.output
    (runs / LOCK_NAME).write_text(json.dumps({"pid": os.getpid(), "run_id": "r1"}))
    result = invoke("r2")
    assert result.exit_code == 1 and "the run going now is r1" in result.output
    assert not stop_requested(runs, "r1")
    result = invoke()
    assert result.exit_code == 0 and "Asked run r1 to stop" in result.output
    assert stop_requested(runs, "r1")


# --- the API ------------------------------------------------------------------------------


def write_run(runs: Path, run_id: str, *, finished: dict | None = None) -> None:
    folder = runs / run_id
    folder.mkdir(parents=True)
    events = [{"run_id": run_id, "seq": 1, "timestamp": "2026-10-26T10:00:00+00:00", "agent": "orchestrator",
               "type": "run_started", "payload": {"issue": "x", "repo": "/r", "mode": "crew"}}]
    if finished is not None:
        events.append({"run_id": run_id, "seq": 2, "timestamp": "2026-10-26T10:01:00+00:00", "agent": "orchestrator",
                       "type": "run_finished", "payload": {"result": finished}})
    (folder / "events.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))


def test_stop_endpoint(tmp_path: Path):
    runs = tmp_path / "runs"
    write_run(runs, "live")
    write_run(runs, "done", finished={"success": True, "stopped": False})
    write_run(runs, "halted", finished={"success": False, "stopped": True, "error": "stopped: stop requested"})
    (runs / LOCK_NAME).write_text(json.dumps({"pid": os.getpid(), "run_id": "live"}))
    client = TestClient(create_app(runs, Launcher(runs, command=[sys.executable, "-c", "pass"])))
    post = lambda run_id, **kw: client.post(f"/api/runs/{run_id}/stop", json={}, **kw)

    summary = lambda run_id: client.get(f"/api/runs/{run_id}").json()["summary"]
    assert (summary("live")["status"], summary("live")["stop_requested"]) == ("running", False)
    response = post("live")
    assert response.status_code == 202 and response.json() == {"run_id": "live", "state": "stopping"}
    assert stop_requested(runs, "live")
    assert (summary("live")["status"], summary("live")["stop_requested"]) == ("running", True)

    assert post("done").status_code == 409
    assert post("nope").status_code == 404
    # A run stopped on request is listed as stopped, with its result.
    assert {s["run_id"]: s["status"] for s in client.get("/api/runs").json()} == {
        "live": "running", "done": "finished", "halted": "stopped"}
    # Same guards as starting a run.
    assert post("live", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/runs/live/stop", content="x", headers={"Content-Type": "text/plain"}).status_code == 415


def test_stop_a_launch_that_has_not_started_its_run(tmp_path: Path):
    runs = tmp_path / "runs"
    launcher = Launcher(runs, command=[sys.executable, "-c", "import time; time.sleep(30)"])
    process = subprocess.Popen(launcher.command)
    launcher.launches["starting"] = Launch(run_id="starting", process=process, log_path=tmp_path / "log", repo="/r")
    launcher.stop("starting")
    assert process.wait(10) != 0
