"""File-system tools confined to a root directory.

Every public function takes ``root`` first and resolves paths through
``resolve_in_root``, which rejects anything that ends up outside the root
after ``..`` segments and symlinks are resolved.
"""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path

from pydantic import BaseModel

MAX_READ_LINES = 200
MAX_READ_CHARS = 8_000
MAX_LINE_CHARS = 400
MAX_LIST_ENTRIES = 200
MAX_SEARCH_RESULTS = 50
MAX_SEARCH_FILE_BYTES = 1_000_000

IGNORED_DIRS = frozenset(
    {
        ".git", ".hg", ".svn", ".venv", "venv", "node_modules", "__pycache__",
        ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".idea", ".vscode",
    }
)


class PathOutsideRootError(PermissionError):
    pass


class SearchMatch(BaseModel):
    path: str
    line: int
    text: str


def resolve_in_root(root: str | os.PathLike[str], path: str | os.PathLike[str]) -> Path:
    """Resolve ``path`` (relative to ``root``, or absolute) and ensure it stays inside root.

    ``Path.resolve`` follows symlinks and collapses ``..``, so a symlink inside
    the repo that points elsewhere is rejected too.
    """
    root_path = Path(root).resolve(strict=True)
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = root_path / candidate
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root_path):
        raise PathOutsideRootError(f"path escapes the repository root: {path}")
    return resolved


def to_relative(root: str | os.PathLike[str], path: str | os.PathLike[str]) -> str:
    """Root-relative POSIX path, the form shown to agents."""
    root_path = Path(root).resolve(strict=True)
    rel = resolve_in_root(root_path, path).relative_to(root_path).as_posix()
    return rel or "."


def _clip(line: str, limit: int = MAX_LINE_CHARS) -> str:
    return line if len(line) <= limit else line[:limit] + " …[line truncated]"


def read_file(
    root: str | os.PathLike[str],
    path: str,
    offset: int = 1,
    limit: int = MAX_READ_LINES,
) -> str:
    """Return up to 200 numbered lines starting at 1-based line ``offset``.

    A footer tells the caller the range shown and the offset to continue from.
    """
    target = resolve_in_root(root, path)
    if not target.is_file():
        raise FileNotFoundError(f"not a file: {path}")
    if offset < 1:
        raise ValueError("offset must be >= 1")
    limit = max(1, min(limit, MAX_READ_LINES))

    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    rel = to_relative(root, target)
    if total == 0:
        return f"[{rel} is empty]"
    if offset > total:
        raise ValueError(f"offset {offset} is past the end of {rel} ({total} lines)")

    out: list[str] = []
    chars = 0
    end = offset - 1
    width = len(str(min(total, offset + limit - 1)))
    for number in range(offset, min(total, offset + limit - 1) + 1):
        rendered = f"{number:>{width}}| {_clip(lines[number - 1])}"
        if out and chars + len(rendered) > MAX_READ_CHARS:
            break
        out.append(rendered)
        chars += len(rendered) + 1
        end = number

    footer = f"[{rel}: lines {offset}-{end} of {total}"
    footer += f"; use offset={end + 1} for more]" if end < total else "]"
    return "\n".join(out) + "\n" + footer


def write_file(root: str | os.PathLike[str], path: str, content: str) -> str:
    """Create or overwrite a file (parent directories are created)."""
    target = resolve_in_root(root, path)
    if target.is_dir():
        raise IsADirectoryError(f"is a directory: {path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="") as fh:
        fh.write(content)
    return f"wrote {len(content)} chars to {to_relative(root, target)}"


def edit_file(root: str | os.PathLike[str], path: str, old: str, new: str) -> str:
    """Replace the single exact occurrence of ``old`` with ``new``.

    Much cheaper in tokens than rewriting a whole file. Line endings of the
    original file are preserved.
    """
    target = resolve_in_root(root, path)
    if not target.is_file():
        raise FileNotFoundError(f"not a file: {path}")
    if not old:
        raise ValueError("old must not be empty")
    with target.open("r", encoding="utf-8", newline="") as fh:
        original = fh.read()
    crlf = "\r\n" in original
    text = original.replace("\r\n", "\n")
    old_n, new_n = old.replace("\r\n", "\n"), new.replace("\r\n", "\n")

    count = text.count(old_n)
    if count == 0:
        raise ValueError(f"old text not found in {path}; read the file and copy it exactly")
    if count > 1:
        raise ValueError(f"old text occurs {count} times in {path}; include more context")
    updated = text.replace(old_n, new_n, 1)
    if crlf:
        updated = updated.replace("\n", "\r\n")
    with target.open("w", encoding="utf-8", newline="") as fh:
        fh.write(updated)
    line = text[: text.index(old_n)].count("\n") + 1
    return f"edited {to_relative(root, target)} at line {line}"


def list_dir(root: str | os.PathLike[str], path: str = ".") -> str:
    """List a directory (non-recursive). Directories end with '/'."""
    target = resolve_in_root(root, path)
    if not target.is_dir():
        raise NotADirectoryError(f"not a directory: {path}")
    entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    names = [
        p.name + "/" if p.is_dir() else p.name
        for p in entries
        if not (p.is_dir() and p.name in IGNORED_DIRS)
    ]
    if not names:
        return "[empty directory]"
    shown = names[:MAX_LIST_ENTRIES]
    if len(names) > MAX_LIST_ENTRIES:
        shown.append(f"[… {len(names) - MAX_LIST_ENTRIES} more entries]")
    return "\n".join(shown)


def search_code(
    root: str | os.PathLike[str],
    pattern: str,
    path: str = ".",
    glob: str | None = None,
    max_results: int = MAX_SEARCH_RESULTS,
) -> list[SearchMatch]:
    """Grep-style search. ``pattern`` is a Python regex (falls back to a literal
    match if it does not compile). ``glob`` filters file names, e.g. ``*.py``.
    """
    root_path = Path(root).resolve(strict=True)
    start = resolve_in_root(root_path, path)
    try:
        regex = re.compile(pattern)
    except re.error:
        regex = re.compile(re.escape(pattern))

    if start.is_file():
        files = [start]
    else:
        files = _walk_files(start, root_path)

    matches: list[SearchMatch] = []
    for file in files:
        rel = file.relative_to(root_path).as_posix()
        if glob and not (fnmatch.fnmatch(file.name, glob) or fnmatch.fnmatch(rel, glob)):
            continue
        for number, line in _text_lines(file):
            if regex.search(line):
                matches.append(SearchMatch(path=rel, line=number, text=_clip(line.strip(), 200)))
                if len(matches) >= max_results:
                    return matches
    return matches


def _walk_files(start: Path, root_path: Path):
    for dirpath, dirnames, filenames in os.walk(start, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
        for name in sorted(filenames):
            file = Path(dirpath) / name
            # Skip symlinked files that point outside the tree.
            if not file.resolve().is_relative_to(root_path):
                continue
            yield file


def _text_lines(file: Path):
    try:
        if file.stat().st_size > MAX_SEARCH_FILE_BYTES:
            return
        data = file.read_bytes()
    except OSError:
        return
    if b"\0" in data[:8192]:
        return  # binary
    for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), start=1):
        yield number, line
