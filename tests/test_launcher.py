"""Starting runs from the dashboard: repo checks, the launcher and its endpoints.

The launched command is a small fake ``patchwork`` script, so no LLM is called.
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from patchwork.config import Settings
from patchwork.launcher import LaunchError, Launcher, LaunchRequest
from patchwork.server import create_app
from patchwork.workspace import inspect_repo

from conftest import TOY_STATS

FAKE_PATCHWORK = r'''
import json, sys
from pathlib import Path
args = sys.argv[1:]
opt = lambda name: args[args.index(name) + 1]
run_id, runs = opt("--run-id"), Path(opt("--runs-dir"))
print("fake patchwork starting", run_id)
if "--crash" in Path(opt("--issue-file")).read_text():
    print("Traceback: boom")
    sys.exit(3)
out = runs / run_id
out.mkdir(parents=True)
event = {"run_id": run_id, "seq": 1, "timestamp": "2026-10-26T10:00:00+00:00", "agent": "orchestrator", "type": "run_started",
         "payload": {"issue": Path(opt("--issue-file")).read_text(), "repo": opt("--repo"), "args": args}}
(out / "events.jsonl").write_text(json.dumps(event) + "\n")
'''


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def make_repo(path: Path, *, commit: bool = True) -> Path:
    path.mkdir(parents=True)
    (path / "app.py").write_text("x = 1\n")
    git(path, "init")
    if commit:
        git(path, "add", "-A")
        git(path, "commit", "-m", "init")
    return path


@pytest.fixture
def settings(monkeypatch) -> Settings:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    return Settings(_env_file=None, groq_api_key="test-key")


@pytest.fixture
def launcher(tmp_path: Path, settings: Settings) -> Launcher:
    script = tmp_path / "fake_patchwork.py"
    script.write_text(FAKE_PATCHWORK)
    return Launcher(tmp_path / "runs", command=[sys.executable, str(script)], settings=settings, cwd=tmp_path)


def wait_exit(launcher: Launcher, run_id: str) -> dict:
    deadline = time.time() + 20
    while time.time() < deadline:
        status = launcher.status(run_id)
        if status["state"] == "exited":
            return status
        time.sleep(0.05)
    raise AssertionError("the fake run didn't finish")


# --- inspect_repo ---------------------------------------------------------------------


def test_inspect_repo_states(tmp_path: Path, git_env) -> None:
    assert inspect_repo(tmp_path / "nope")["state"] == "missing"
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "ISSUE.md").write_text("Fix it")
    info = inspect_repo(plain)
    assert info["state"] == "needs_init" and info["issue_files"] == ["ISSUE.md"]

    repo = make_repo(tmp_path / "repo")
    ready = inspect_repo(repo)
    assert ready["state"] == "ready" and ready["branch"] == "main" and ready["message"].startswith("Clean git repo on main at ")

    (repo / "sub").mkdir()
    assert inspect_repo(repo / "sub")["state"] == "inside_repo"

    (repo / "app.py").write_text("x = 2\n")
    dirty = inspect_repo(repo)
    assert dirty["state"] == "dirty" and dirty["dirty_files"] == ["app.py"] and dirty["dirty_count"] == 1

    assert inspect_repo(make_repo(tmp_path / "empty", commit=False))["state"] == "no_commits"


# --- Launcher -------------------------------------------------------------------------


def test_start_runs_patchwork_in_the_background_with_the_options(launcher: Launcher, tmp_path: Path, git_env) -> None:
    repo = make_repo(tmp_path / "repo")
    run_id = launcher.start(LaunchRequest(repo=str(repo), issue="  Fix the bug  ", sequential=True, max_retries=1, max_steps=9, test_cmd="pytest -x"))
    status = wait_exit(launcher, run_id)
    assert status["exit_code"] == 0 and status["has_events"]
    started = json.loads((launcher.runs / run_id / "events.jsonl").read_text())
    assert started["payload"]["issue"] == "Fix the bug"
    assert started["payload"]["repo"] == str(repo.resolve())
    args = started["payload"]["args"]
    assert args[:2] == ["run", "--repo"]
    for flag in (["--run-id", run_id], ["--sequential"], ["--max-retries", "1"], ["--max-steps", "9"], ["--test-cmd", "pytest -x"]):
        assert " ".join(flag) in " ".join(args)
    assert "--init-git" not in args
    assert "fake patchwork starting" in status["log"]


def test_a_toy_repo_is_copied_and_gets_its_issue_and_init_git(launcher: Launcher, git_env) -> None:
    before = sorted(p.name for p in TOY_STATS.iterdir())
    run_id = launcher.start(LaunchRequest(toy="stats_feature"))
    wait_exit(launcher, run_id)
    payload = json.loads((launcher.runs / run_id / "events.jsonl").read_text())["payload"]
    assert payload["issue"] == (TOY_STATS / "ISSUE.md").read_text(encoding="utf-8-sig").strip()
    assert Path(payload["repo"]).name == "stats_feature" and Path(payload["repo"]) != TOY_STATS
    assert (Path(payload["repo"]) / "stats" / "core.py").is_file()
    assert "--init-git" in payload["args"]
    assert sorted(p.name for p in TOY_STATS.iterdir()) == before


def test_toy_repos_are_listed_with_their_issue(launcher: Launcher) -> None:
    toys = {t["name"]: t for t in launcher.toy_repos()}
    assert {"calculator", "stats_feature", "text_utils"} <= set(toys)
    assert "median" in toys["stats_feature"]["issue"]
    assert toys["calculator"]["issue"] is None


def test_a_run_that_dies_before_writing_events_reports_its_output(launcher: Launcher, tmp_path: Path, git_env) -> None:
    repo = make_repo(tmp_path / "repo")
    run_id = launcher.start(LaunchRequest(repo=str(repo), issue="--crash"))
    status = wait_exit(launcher, run_id)
    assert status["exit_code"] == 3 and not status["has_events"]
    assert status["log"].splitlines()[-1] == "Traceback: boom"


@pytest.mark.parametrize(
    ("request_kwargs", "status", "message"),
    [
        ({"issue": "x"}, 400, "Pick a repo folder"),
        ({"repo": "REPO", "issue": "   "}, 400, "Describe the issue"),
        ({"toy": "nope", "issue": "x"}, 400, "no toy repo"),
        ({"repo": "PLAIN", "issue": "x"}, 400, "initialize git"),
        ({"repo": "DIRTY", "issue": "x"}, 400, "uncommitted change"),
        ({"repo": "REPO", "issue": "x" * 20_001}, 400, "too long"),
    ],
)
def test_bad_requests_are_refused_before_anything_starts(launcher: Launcher, tmp_path: Path, git_env, request_kwargs, status, message) -> None:
    repo = make_repo(tmp_path / "repo")
    plain = tmp_path / "plain"
    plain.mkdir()
    dirty = make_repo(tmp_path / "dirty")
    (dirty / "app.py").write_text("changed\n")
    paths = {"REPO": str(repo), "PLAIN": str(plain), "DIRTY": str(dirty)}
    kwargs = {k: paths.get(v, v) if isinstance(v, str) else v for k, v in request_kwargs.items()}
    with pytest.raises(LaunchError) as error:
        launcher.start(LaunchRequest(**kwargs))
    assert error.value.status == status and message in error.value.message
    assert launcher.launches == {}


def test_a_plain_folder_starts_with_init_git(launcher: Launcher, tmp_path: Path, git_env) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    run_id = launcher.start(LaunchRequest(repo=str(plain), issue="x", init_git=True))
    wait_exit(launcher, run_id)
    assert "--init-git" in json.loads((launcher.runs / run_id / "events.jsonl").read_text())["payload"]["args"]


def test_no_api_key_is_refused(tmp_path: Path, monkeypatch, git_env) -> None:
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    launcher = Launcher(tmp_path / "runs", settings=Settings(_env_file=None, groq_api_key=None))
    with pytest.raises(LaunchError, match="GROQ_API_KEY is not set"):
        launcher.start(LaunchRequest(repo=str(make_repo(tmp_path / "repo")), issue="x"))
    assert launcher.config()["api_key_set"] is False


def test_only_one_run_at_a_time(launcher: Launcher, tmp_path: Path, git_env) -> None:
    launcher.runs.mkdir(parents=True)
    (launcher.runs / ".patchwork.lock").write_text(json.dumps({"pid": os.getpid(), "run_id": "20261026-000000-busy"}))
    with pytest.raises(LaunchError) as error:
        launcher.start(LaunchRequest(repo=str(make_repo(tmp_path / "repo")), issue="x"))
    assert error.value.status == 409 and "20261026-000000-busy" in error.value.message
    assert launcher.config()["busy"] == "20261026-000000-busy"


# --- endpoints ------------------------------------------------------------------------


@pytest.fixture
def client(launcher: Launcher) -> TestClient:
    return TestClient(create_app(launcher.runs, launcher=launcher))


DASHBOARD = {"Origin": "http://localhost:3000"}


def test_start_a_run_over_http_and_follow_its_launch(client: TestClient, tmp_path: Path, git_env) -> None:
    repo = make_repo(tmp_path / "repo")
    response = client.post("/api/runs", json={"repo": str(repo), "issue": "Fix it"}, headers=DASHBOARD)
    assert response.status_code == 201
    run_id = response.json()["run_id"]
    deadline = time.time() + 20
    while (status := client.get(f"/api/launches/{run_id}", headers=DASHBOARD).json())["state"] != "exited":
        assert time.time() < deadline
        time.sleep(0.05)
    assert status["exit_code"] == 0
    assert client.get(f"/api/runs/{run_id}/events").json()[0]["type"] == "run_started"


def test_errors_come_back_as_messages(client: TestClient, tmp_path: Path, git_env) -> None:
    response = client.post("/api/runs", json={"repo": str(tmp_path / "missing"), "issue": "x"}, headers=DASHBOARD)
    assert response.status_code == 400 and response.json()["detail"] == "No such folder."
    assert client.get("/api/launches/20261026-000000-none", headers=DASHBOARD).status_code == 404


def test_other_web_pages_cannot_start_runs(client: TestClient, tmp_path: Path, git_env) -> None:
    repo = str(make_repo(tmp_path / "repo"))
    evil = client.post("/api/runs", json={"repo": repo, "issue": "x"}, headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403
    form = client.post("/api/runs", content=json.dumps({"repo": repo, "issue": "x"}), headers={**DASHBOARD, "Content-Type": "text/plain"})
    assert form.status_code == 415
    assert client.get("/api/repo-check", params={"path": repo}, headers={"Origin": "https://evil.example"}).status_code == 403


def test_form_helpers(client: TestClient, tmp_path: Path, git_env) -> None:
    repo = make_repo(tmp_path / "repo")
    (repo / "ISSUE.md").write_text("Add median()\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-m", "issue")
    check = client.get("/api/repo-check", params={"path": str(repo)}, headers=DASHBOARD).json()
    assert check["state"] == "ready" and check["issue"] == "Add median()"
    config = client.get("/api/config", headers=DASHBOARD).json()
    assert config["api_key_set"] is True and set(config["models"]) == {"lead", "tester", "coder", "reviewer"}
    assert "stats_feature" in [t["name"] for t in client.get("/api/toy-repos", headers=DASHBOARD).json()]
