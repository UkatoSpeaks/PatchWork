"""One run at a time (runs/.patchwork.lock) and the daily usage file / `patchwork usage`."""

import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest
from typer.testing import CliRunner

import patchwork.cli as cli
from patchwork.runlock import LOCK_NAME, RunLocked, pid_alive, run_lock
from patchwork.usage import UsageStore


def dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    return proc.pid


def test_pid_alive():
    assert pid_alive(os.getpid())
    assert not pid_alive(dead_pid())


def test_lock_is_taken_and_released(tmp_path: Path):
    lock = tmp_path / "runs" / LOCK_NAME
    with run_lock(tmp_path / "runs", "run-a"):
        holder = json.loads(lock.read_text())
        assert (holder["pid"], holder["run_id"]) == (os.getpid(), "run-a")
    assert not lock.exists()


def test_lock_is_released_after_an_error(tmp_path: Path):
    with pytest.raises(ValueError):
        with run_lock(tmp_path, "run-a"):
            raise ValueError("boom")
    assert not (tmp_path / LOCK_NAME).exists()


def test_second_run_is_refused_while_a_live_process_holds_the_lock(tmp_path: Path):
    with run_lock(tmp_path, "run-a"):
        with pytest.raises(RunLocked) as info:
            with run_lock(tmp_path, "run-b"):
                pass
        assert str(info.value) == (
            f"another Patchwork run is in progress (run run-a, pid {os.getpid()}); "
            "Groq rate limits are shared, run one at a time"
        )
        assert json.loads((tmp_path / LOCK_NAME).read_text())["run_id"] == "run-a"  # untouched
    assert not (tmp_path / LOCK_NAME).exists()


def test_stale_lock_is_cleared(tmp_path: Path):
    (tmp_path / LOCK_NAME).write_text(json.dumps({"pid": dead_pid(), "run_id": "old"}))
    with run_lock(tmp_path, "new"):
        assert json.loads((tmp_path / LOCK_NAME).read_text())["run_id"] == "new"
    assert not (tmp_path / LOCK_NAME).exists()


def test_cli_run_refuses_while_locked(tmp_path: Path, monkeypatch):
    runs = tmp_path / "runs"
    runs.mkdir()
    (runs / LOCK_NAME).write_text(json.dumps({"pid": os.getpid(), "run_id": "busy-run"}))
    monkeypatch.setattr(cli, "RUNS_DIR", runs)
    monkeypatch.setattr(cli, "LLMClient", lambda **kw: pytest.fail("no LLM client while locked"))
    repo = tmp_path / "repo"
    repo.mkdir()
    result = CliRunner().invoke(cli.app, ["run", "--repo", str(repo), "--issue", "x"],
                                env={"CODER_MODEL": "coder", "LEAD_MODEL": "lead", "TESTER_MODEL": "tester",
                                     "REVIEWER_MODEL": "reviewer"})
    assert result.exit_code == 2
    assert f"another Patchwork run is in progress (run busy-run, pid {os.getpid()})" in result.output
    assert [p.name for p in runs.iterdir()] == [LOCK_NAME]  # no run dir created


# --- usage ---------------------------------------------------------------------------------

def test_usage_store_accumulates_per_model_per_day(tmp_path: Path):
    day = [date(2026, 10, 17)]
    store = UsageStore(tmp_path / "usage.json", today=lambda: day[0])
    store.record("a", 100, 20)
    day[0] = date(2026, 10, 18)
    store.record("a", 10, 5)
    store.record("a", 10, 5)
    store.record("b", 1, 1)
    store.note_reported("a", tokens_per_day=200000)
    assert store.days() == ["2026-10-17", "2026-10-18"]
    assert store.day() == {
        "a": {"tokens": 30, "requests": 2, "tokens_per_day": 200000, "requests_per_day": None},
        "b": {"tokens": 2, "requests": 1, "tokens_per_day": None, "requests_per_day": None},
    }
    assert store.day("2026-10-17")["a"]["tokens"] == 120
    # Groq's own count raises today's total, never lowers it.
    store.note_reported("a", used_tokens=1000)
    store.note_reported("a", used_tokens=10)
    assert store.day()["a"]["tokens"] == 1000


def test_patchwork_usage_command(tmp_path: Path, monkeypatch):
    runs = tmp_path / "runs"
    monkeypatch.setattr(cli, "RUNS_DIR", runs)
    runner = CliRunner()
    assert "No usage recorded today" in runner.invoke(cli.app, ["usage"]).output

    store = UsageStore(runs / "usage.json")
    store.record("groq/openai/gpt-oss-120b", 150000, 2400)
    store.note_reported("groq/openai/gpt-oss-120b", tokens_per_day=200000, requests_per_day=1000)
    store.record("groq/qwen/qwen3.8-27b", 900, 100)
    out = runner.invoke(cli.app, ["usage"])
    assert out.exit_code == 0
    assert out.output.splitlines() == [
        "groq/openai/gpt-oss-120b today: 152,400 / 200,000 tokens, 1 / 1,000 requests",
        "groq/qwen/qwen3.8-27b today: 1,000 tokens, 1 requests",
    ]
    history = runner.invoke(cli.app, ["usage", "--days", "7"]).output.splitlines()
    assert history[0] == date.today().isoformat()
    assert history[1].startswith("  groq/openai/gpt-oss-120b total: 152,400")
