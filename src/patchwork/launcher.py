"""Starting crew runs from the dashboard.

``Launcher.start`` checks a request (repo state, issue text, API key, no other
run going) and then runs ``patchwork run`` as its own background process, with
a run id picked here so the dashboard can open the run at once. The process is
started in a new session, so stopping the server doesn't stop the run. Its
console output goes to ``runs/.launch/<run_id>/console.log``; the run itself
writes ``runs/<run_id>/`` like any CLI run.

Toy repos (``toy_repos/`` in a source checkout) are copied to a temp folder
first, so the originals are never touched, and get ``--init-git``.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from patchwork.config import Role, Settings
from patchwork.events import new_run_id
from patchwork.runlock import LOCK_NAME, pid_alive, read_lock
from patchwork.workspace import inspect_repo, issue_files

TOY_REPOS = Path(__file__).resolve().parents[2] / "toy_repos"
LAUNCH_DIR = ".launch"
MAX_ISSUE_CHARS = 20_000
LOG_TAIL_LINES = 40
# The crew's roles (as in orchestrator.CREW, without importing the agents here).
CREW: tuple[Role, ...] = ("lead", "tester", "coder", "reviewer")
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


class LaunchRequest(BaseModel):
    """A crew run to start: a repo path or a toy repo, and the issue."""

    repo: str | None = None
    toy: str | None = None
    issue: str = ""
    init_git: bool = False
    sequential: bool = False
    max_retries: int | None = Field(default=None, ge=0, le=10)
    max_steps: int | None = Field(default=None, ge=1, le=200)
    test_cmd: str | None = Field(default=None, max_length=500)


class LaunchError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Launch:
    run_id: str
    process: subprocess.Popen[bytes]
    log_path: Path
    repo: str
    started: float = field(default_factory=time.time)


def _first_line(text: str) -> str:
    return next((line.strip().lstrip("#").strip() for line in text.splitlines() if line.strip()), "")


def read_issue_file(repo: Path) -> str | None:
    """The text of the folder's ISSUE.md (or issue.md, ISSUE.txt), if it has one."""
    for name in issue_files(repo):
        try:
            return (repo / name).read_text(encoding="utf-8-sig").strip()[:MAX_ISSUE_CHARS]
        except (OSError, UnicodeDecodeError):
            return None
    return None


class Launcher:
    def __init__(
        self,
        runs: Path | str,
        *,
        cwd: Path | str | None = None,
        command: list[str] | None = None,
        toy_repos: Path | str = TOY_REPOS,
        settings: Settings | None = None,
    ) -> None:
        self.runs = Path(runs).resolve()
        # .env is read from the working directory, so runs start in the server's.
        self.cwd = Path(cwd or Path.cwd())
        self.command = command or [sys.executable, "-m", "patchwork.cli"]
        self.toy_root = Path(toy_repos)
        self._settings = settings
        self.launches: dict[str, Launch] = {}

    def settings(self) -> Settings:
        # Re-read .env each time, so edits show up without restarting the server.
        return self._settings or Settings()

    # --- what the form shows ------------------------------------------------------

    def config(self) -> dict[str, Any]:
        s = self.settings()
        models = {role: s.model_for(role) for role in CREW}
        return {
            "models": models,
            "coder_retry_model": s.coder_retry_model_or_default(),
            "api_key_set": bool(s.api_key()),
            "needs_api_key": any(m.startswith("groq/") for m in models.values()),
            "max_retries": s.max_retries,
            "max_steps": s.max_steps_per_agent,
            "test_command": s.test_command,
            "busy": self.busy(),
        }

    def toy_repos(self) -> list[dict[str, Any]]:
        if not self.toy_root.is_dir():
            return []
        toys = []
        for path in sorted(self.toy_root.iterdir()):
            if not path.is_dir() or path.name.startswith("."):
                continue
            issue = read_issue_file(path)
            readme = path / "README.md"
            about = _first_line(readme.read_text(encoding="utf-8", errors="replace")) if readme.is_file() else ""
            toys.append({"name": path.name, "about": about, "issue": issue})
        return toys

    def check_repo(self, path: str) -> dict[str, Any]:
        info = inspect_repo(path)
        if info["state"] != "missing":
            info["issue"] = read_issue_file(Path(str(info["path"])))
        return info

    # --- starting and following runs ---------------------------------------------

    def busy(self) -> str | None:
        """The id of a run that is going (or starting), if any."""
        holder = read_lock(self.runs / LOCK_NAME) or {}
        pid = holder.get("pid")
        if isinstance(pid, int) and pid_alive(pid):
            return str(holder.get("run_id") or "?")
        for launch in self.launches.values():
            if launch.process.poll() is None:
                return launch.run_id
        return None

    def start(self, request: LaunchRequest) -> str:
        issue = request.issue.strip()
        init_git = request.init_git
        if request.toy:
            toys = {t["name"]: t for t in self.toy_repos()}
            if request.toy not in toys:
                raise LaunchError(400, f"no toy repo {request.toy!r}")
            issue = issue or (toys[request.toy]["issue"] or "")
        elif not (request.repo or "").strip():
            raise LaunchError(400, "Pick a repo folder or a toy repo.")
        if not issue:
            raise LaunchError(400, "Describe the issue to fix.")
        if len(issue) > MAX_ISSUE_CHARS:
            raise LaunchError(400, f"The issue is too long ({len(issue):,} characters, max {MAX_ISSUE_CHARS:,}).")

        settings = self.settings()
        if any(settings.model_for(r).startswith("groq/") for r in CREW) and not settings.api_key():
            raise LaunchError(400, "GROQ_API_KEY is not set. Add it to .env (see .env.example), then try again.")
        running = self.busy()
        if running:
            raise LaunchError(409, f"Run {running} is still going. Patchwork runs one at a time (rate limits are shared).")

        if request.toy:
            # A fresh copy each time: the originals stay untouched.
            repo = Path(tempfile.mkdtemp(prefix="patchwork-toy-")) / request.toy
            shutil.copytree(self.toy_root / request.toy, repo, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", ".git"))
            init_git = True
        else:
            info = inspect_repo(request.repo or "")
            state = info["state"]
            if state == "needs_init" and not init_git:
                raise LaunchError(400, f"{info['message']} Tick “initialize git” to do that.")
            if state not in ("ready", "needs_init"):
                raise LaunchError(400, str(info["message"]))
            repo = Path(str(info["path"]))

        run_id = new_run_id()
        while (self.runs / run_id).exists():
            run_id = new_run_id()
        folder = self.runs / LAUNCH_DIR / run_id
        folder.mkdir(parents=True)
        issue_path = folder / "issue.md"
        issue_path.write_text(issue, encoding="utf-8")
        log_path = folder / "console.log"

        args = [
            *self.command, "run",
            "--repo", str(repo),
            "--issue-file", str(issue_path),
            "--run-id", run_id,
            "--runs-dir", str(self.runs),
        ]
        if init_git:
            args.append("--init-git")
        if request.sequential:
            args.append("--sequential")
        if request.max_retries is not None:
            args += ["--max-retries", str(request.max_retries)]
        if request.max_steps is not None:
            args += ["--max-steps", str(request.max_steps)]
        if request.test_cmd and request.test_cmd.strip():
            args += ["--test-cmd", request.test_cmd.strip()]

        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "NO_COLOR": "1"}
        detach: dict[str, Any] = (
            {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS}  # type: ignore[attr-defined]
            if sys.platform == "win32"
            else {"start_new_session": True}
        )
        with log_path.open("wb") as log:
            process = subprocess.Popen(args, cwd=self.cwd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env, **detach)
        self.launches[run_id] = Launch(run_id=run_id, process=process, log_path=log_path, repo=str(repo))
        return run_id

    def status(self, run_id: str) -> dict[str, Any] | None:
        """How a run started here is doing: ``starting`` (process up, no events
        yet), ``running`` or ``exited`` (with the exit code and the end of its
        console output). None for runs this server didn't start."""
        launch = self.launches.get(run_id)
        if launch is None:
            return None
        code = launch.process.poll()
        has_events = (self.runs / run_id / "events.jsonl").is_file()
        state = "exited" if code is not None else "running" if has_events else "starting"
        return {
            "run_id": run_id,
            "state": state,
            "exit_code": code,
            "has_events": has_events,
            "repo": launch.repo,
            "seconds": round(time.time() - launch.started, 1),
            "log": self.log_tail(launch) if code is not None else "",
        }

    @staticmethod
    def log_tail(launch: Launch) -> str:
        try:
            text = launch.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""
        return "\n".join(_ANSI.sub("", text).rstrip().splitlines()[-LOG_TAIL_LINES:])
