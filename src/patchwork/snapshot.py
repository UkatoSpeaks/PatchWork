"""Copy a repository before a run and diff it afterwards.

The diff and the list of changed files come from comparing the copy with the
working tree, so they reflect what really changed on disk, whatever the
agents claim.
"""

from __future__ import annotations

import difflib
import os
import shutil
import tempfile
from pathlib import Path

from pydantic import BaseModel

from patchwork.tools.fs import IGNORED_DIRS

IGNORED_SUFFIXES = (".pyc", ".pyo")


class RepoDiff(BaseModel):
    files_changed: list[str]
    diff: str


class Snapshot:
    """A copy of ``repo`` in a temp dir. Use as a context manager to clean up."""

    def __init__(self, repo: str | os.PathLike[str]) -> None:
        self.repo = Path(repo).resolve(strict=True)
        self._tmp = tempfile.TemporaryDirectory(prefix="patchwork-snapshot-", ignore_cleanup_errors=True)
        self.path = Path(self._tmp.name) / "repo"
        shutil.copytree(self.repo, self.path, symlinks=True, ignore=_ignore)

    def __enter__(self) -> Snapshot:
        return self

    def __exit__(self, *exc: object) -> None:
        self.cleanup()

    def cleanup(self) -> None:
        self._tmp.cleanup()

    def changed_files(self) -> list[str]:
        before, after = _files(self.path), _files(self.repo)
        return [
            rel for rel in sorted(before.keys() | after.keys())
            if _read(before.get(rel)) != _read(after.get(rel))
        ]

    def diff(self) -> RepoDiff:
        before, after = _files(self.path), _files(self.repo)
        changed, chunks = [], []
        for rel in sorted(before.keys() | after.keys()):
            old, new = _read(before.get(rel)), _read(after.get(rel))
            if old != new:
                changed.append(rel)
                chunks.append(_file_diff(rel, old, new))
        return RepoDiff(files_changed=changed, diff="".join(chunks))


def _ignore(directory: str, names: list[str]) -> set[str]:
    return {
        n for n in names
        if (n in IGNORED_DIRS and os.path.isdir(os.path.join(directory, n))) or n.endswith(IGNORED_SUFFIXES)
    }


def _files(root: Path) -> dict[str, Path]:
    """Regular files under root by POSIX relative path (symlinks are skipped)."""
    out: dict[str, Path] = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
        for name in filenames:
            path = Path(dirpath) / name
            if name.endswith(IGNORED_SUFFIXES) or path.is_symlink():
                continue
            out[path.relative_to(root).as_posix()] = path
    return out


def _read(path: Path | None) -> bytes | None:
    return path.read_bytes() if path is not None else None


def _file_diff(rel: str, old: bytes | None, new: bytes | None) -> str:
    fromfile = f"a/{rel}" if old is not None else "/dev/null"
    tofile = f"b/{rel}" if new is not None else "/dev/null"
    if b"\0" in (old or b"")[:8192] or b"\0" in (new or b"")[:8192]:
        return f"Binary files {fromfile} and {tofile} differ\n"
    old_lines = (old or b"").decode("utf-8", errors="replace").splitlines(keepends=True)
    new_lines = (new or b"").decode("utf-8", errors="replace").splitlines(keepends=True)
    out = []
    for line in difflib.unified_diff(old_lines, new_lines, fromfile, tofile):
        out.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    if not out:  # e.g. an empty file created or deleted
        out = [f"--- {fromfile}\n", f"+++ {tofile}\n"]
    return "".join(out)
