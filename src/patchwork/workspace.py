"""Git repository checks, per-run branches and worktrees.

Each run works on branches ``patchwork/<run_id>/{tester,coder,result}``
created from the current HEAD, each checked out in its own worktree under a
temp dir. The user's working tree is never modified. Plain git via
subprocess; no extra library.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

PATCHWORK_IDENTITY = ("Patchwork", "patchwork@localhost")


class WorkspaceError(RuntimeError):
    """The repo can't be used, or a git operation failed."""


class MergeConflict(WorkspaceError):
    def __init__(self, branch: str, files: list[str]) -> None:
        super().__init__(
            f"merging {branch} into the result branch conflicted in: {', '.join(files) or '(unknown files)'}. "
            "This should not happen (the tester only creates new test files and the coder can't touch them)."
        )
        self.branch = branch
        self.files = files


def git(cwd: str | os.PathLike[str], *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        raise WorkspaceError("git is not installed or not on PATH; Patchwork needs git for crew runs") from None
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise WorkspaceError(f"git {' '.join(args)} failed: {detail}")
    return proc


def _identity_args(cwd: Path) -> list[str]:
    """Use the user's git identity if configured, else a Patchwork one."""
    name = git(cwd, "config", "user.name", check=False).stdout.strip()
    email = git(cwd, "config", "user.email", check=False).stdout.strip()
    if name and email:
        return []
    return ["-c", f"user.name={name or PATCHWORK_IDENTITY[0]}", "-c", f"user.email={email or PATCHWORK_IDENTITY[1]}"]


def ensure_repo(repo: str | os.PathLike[str], *, init_git: bool = False) -> None:
    """Check ``repo`` is the root of a clean git repo with a commit.

    With ``init_git``, a directory that isn't its own git repo is initialised
    and everything in it committed.
    """
    repo = Path(repo).resolve(strict=True)
    top = git(repo, "rev-parse", "--show-toplevel", check=False)
    is_root = top.returncode == 0 and Path(top.stdout.strip()).resolve() == repo
    if not is_root:
        if not init_git:
            where = f" (it is inside the git repo {top.stdout.strip()})" if top.returncode == 0 else ""
            raise WorkspaceError(
                f"{repo} is not a git repository{where}. Commit it to git first, or pass --init-git to "
                "run `git init` and commit everything in it."
            )
        git(repo, "init")
        git(repo, "add", "-A")
        git(repo, *_identity_args(repo), "commit", "--allow-empty", "-m", "Initial commit (patchwork --init-git)")
    if git(repo, "rev-parse", "--verify", "HEAD", check=False).returncode != 0:
        raise WorkspaceError(f"{repo} has no commits yet; commit your code first")
    status = git(repo, "status", "--porcelain").stdout.strip()
    if status:
        shown = "\n".join(status.splitlines()[:10])
        raise WorkspaceError(f"{repo} has uncommitted changes; commit or stash them first:\n{shown}")


class Workspace:
    """Branches and worktrees for one run. Call ``cleanup`` in a finally block."""

    def __init__(self, repo: str | os.PathLike[str], run_id: str) -> None:
        self.repo = Path(repo).resolve(strict=True)
        self.run_id = run_id
        self.base = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        self.root = Path(tempfile.mkdtemp(prefix=f"patchwork-{run_id}-"))
        self.worktrees: dict[str, Path] = {}
        # Branches merged into the result so far.
        self.merged: list[str] = []
        self._identity = _identity_args(self.repo)

    def branch(self, name: str) -> str:
        return f"patchwork/{self.run_id}/{name}"

    def has_branch(self, name: str) -> bool:
        return git(self.repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{self.branch(name)}", check=False).returncode == 0

    def add_worktree(self, name: str) -> Path:
        path = self.root / name
        git(self.repo, "worktree", "add", "-b", self.branch(name), str(path), self.base)
        self.worktrees[name] = path
        return path

    def commit_all(self, name: str, message: str) -> bool:
        """Commit everything in worktree ``name``. False if there was nothing to commit."""
        path = self.worktrees[name]
        git(path, "add", "-A")
        if git(path, "diff", "--cached", "--quiet", check=False).returncode == 0:
            return False
        git(path, *self._identity, "commit", "--no-verify", "-m", message)
        return True

    def changed_files(self, name: str) -> list[str]:
        """Files changed on branch ``name`` relative to the run's base commit."""
        out = git(self.repo, "diff", "--name-only", "--no-renames", self.base, self.branch(name)).stdout
        return sorted(line for line in out.splitlines() if line.strip())

    def diff(self, name: str) -> str:
        return git(
            self.repo, "diff", "--no-color", "--no-ext-diff", "--no-renames",
            "--src-prefix=a/", "--dst-prefix=b/", self.base, self.branch(name),
        ).stdout

    def merge(self, into: str, name: str) -> list[str]:
        """Merge branch ``name`` into worktree ``into``. Returns the files it brought in."""
        path = self.worktrees[into]
        files = self.changed_files(name)
        proc = git(path, *self._identity, "merge", "--no-ff", "--no-edit", "-m",
                   f"patchwork: merge {name}", self.branch(name), check=False)
        if proc.returncode != 0:
            conflicted = git(path, "diff", "--name-only", "--diff-filter=U", check=False).stdout.split()
            git(path, "merge", "--abort", check=False)
            raise MergeConflict(self.branch(name), sorted(conflicted))
        self.merged.append(name)
        return files

    def cleanup(self, delete_branches: tuple[str, ...] = ()) -> None:
        """Remove every worktree and the temp dir; delete the given branches."""
        for path in self.worktrees.values():
            git(self.repo, "worktree", "remove", "--force", str(path), check=False)
        self.worktrees.clear()
        git(self.repo, "worktree", "prune", check=False)
        for name in delete_branches:
            if self.has_branch(name):
                git(self.repo, "branch", "-D", self.branch(name), check=False)
        shutil.rmtree(self.root, ignore_errors=True)
