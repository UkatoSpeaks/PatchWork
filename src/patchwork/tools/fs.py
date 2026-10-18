"""File-system tools confined to a root directory.

Every public function takes ``root`` first and resolves paths through
``resolve_in_root``, which rejects anything that ends up outside the root
after ``..`` segments and symlinks are resolved.
"""

from __future__ import annotations

import ast
import difflib
import fnmatch
import os
import re
import warnings
from pathlib import Path, PurePosixPath

from pydantic import BaseModel

MAX_READ_LINES = 200
MAX_READ_CHARS = 8_000
MAX_LINE_CHARS = 400
MAX_LIST_ENTRIES = 200
MAX_SEARCH_RESULTS = 50
MAX_SEARCH_FILE_BYTES = 1_000_000
# Lines of context shown around an edited region, and the most lines shown.
REGION_CONTEXT = 5
MAX_REGION_LINES = 50

IGNORED_DIRS = frozenset(
    {
        ".git", ".hg", ".svn", ".venv", "venv", "node_modules", "__pycache__",
        ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".idea", ".vscode",
    }
)


class PathOutsideRootError(PermissionError):
    pass


class InvalidPython(ValueError):
    """A write that would leave a .py file unparseable."""


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
        raise _not_a_file(root, path, target)
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
    """Create or overwrite a file (parent directories are created).

    The result shows the changed region, plus a warning if a .py file now
    defines a top-level name twice.
    """
    return _write_file(root, path, content) + _duplicate_warning(root, path)


def edit_file(root: str | os.PathLike[str], path: str, old: str, new: str) -> str:
    """Replace the single exact occurrence of ``old`` with ``new``; see ``_edit_file``."""
    return _edit_file(root, path, old, new) + _duplicate_warning(root, path)


def insert_lines(root: str | os.PathLike[str], path: str, after_line: int, text: str) -> str:
    """Insert ``text`` after line ``after_line``; see ``_insert_lines``."""
    return _insert_lines(root, path, after_line, text) + _duplicate_warning(root, path)


def duplicate_definitions(text: str) -> dict[str, list[int]]:
    """Top-level function/class names defined more than once, with their lines.

    ``@overload`` stubs are legitimate repeats and are ignored.
    """
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return {}
    seen: dict[str, list[int]] = {}
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        if any(_decorator_name(d) == "overload" for d in node.decorator_list):
            continue
        seen.setdefault(node.name, []).append(node.lineno)
    return {name: lines for name, lines in seen.items() if len(lines) > 1}


def _decorator_name(node: ast.expr) -> str:
    if isinstance(node, ast.Call):
        node = node.func
    if isinstance(node, ast.Attribute):
        return node.attr
    return node.id if isinstance(node, ast.Name) else ""


def _duplicate_warning(root: str | os.PathLike[str], path: str) -> str:
    target = resolve_in_root(root, path)
    if target.suffix != ".py" or not target.is_file():
        return ""
    notes = []
    for name, lines in duplicate_definitions(_read_text(target)).items():
        times = "twice" if len(lines) == 2 else f"{len(lines)} times"
        where = ", ".join(str(n) for n in lines[:-1]) + f" and {lines[-1]}"
        notes.append(f"WARNING: {name} is now defined {times} (lines {where}); remove one")
    return "".join("\n" + note for note in notes)


def _write_file(root: str | os.PathLike[str], path: str, content: str) -> str:
    """Create or overwrite a file (parent directories are created).

    An overwritten file keeps its line-ending style. A .py file is only
    written if it parses. The result shows the changed region, numbered.
    """
    target = resolve_in_root(root, path)
    if target.is_dir():
        raise IsADirectoryError(f"is a directory: {path}")
    rel = _rel_of(root, target)
    new_text = _to_lf(content)
    old_text = _read_text(target) if target.is_file() else None
    check_python(rel, new_text)
    crlf = old_text is not None and _is_crlf(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    _write_text(target, new_text, crlf)

    lines = new_text.splitlines()
    if old_text is None:
        head = f"wrote {len(content)} chars to {rel} (new file, {len(lines)} lines)"
        return head + ("\n" + render_region(lines, 1, len(lines), context=0) if lines else "")
    first, last = _changed_lines(_to_lf(old_text).splitlines(), lines)
    head = f"wrote {len(content)} chars to {rel} ({len(lines)} lines)"
    if first is None:
        return head + "; content unchanged"
    return head + f"; changed lines {first}-{last}:\n" + render_region(lines, first, last)


def _edit_file(root: str | os.PathLike[str], path: str, old: str, new: str) -> str:
    """Replace the single exact occurrence of ``old`` with ``new``.

    Much cheaper in tokens than rewriting a whole file. Matching ignores CRLF
    vs LF; the file keeps its original line endings. A .py file is only
    written if the result parses. The result shows the edited region,
    numbered; a failed match shows the closest region instead.
    """
    target = resolve_in_root(root, path)
    if not target.is_file():
        raise _not_a_file(root, path, target)
    if not old:
        raise ValueError("old must not be empty")
    rel = _rel_of(root, target)
    crlf = _is_crlf(target)
    text = _to_lf(_read_text(target))
    old_n, new_n = _to_lf(old), _to_lf(new)

    count = text.count(old_n)
    if count == 0:
        # Models sometimes copy read_file's "N| " line-number prefixes.
        stripped_old, stripped_new = _strip_line_numbers(old_n), _strip_line_numbers(new_n)
        if stripped_old is not None and text.count(stripped_old) == 1:
            old_n, new_n, count = stripped_old, stripped_new if stripped_new is not None else new_n, 1
    if count == 0:
        raise ValueError(_not_found_message(rel, text, old_n))
    if count > 1:
        starts = [m.start() for m in re.finditer(re.escape(old_n), text)]
        lines_at = ", ".join(str(text[:i].count("\n") + 1) for i in starts[:10])
        raise ValueError(f"old text occurs {count} times in {rel} (at lines {lines_at}); include more context")

    index = text.index(old_n)
    updated = text[:index] + new_n + text[index + len(old_n):]
    check_python(rel, updated)
    _write_text(target, updated, crlf)

    first = text[:index].count("\n") + 1
    last = first + max(0, len(new_n.splitlines()) - 1)
    return f"edited {rel} at line {first}; it now reads:\n" + render_region(updated.splitlines(), first, last)


def _insert_lines(root: str | os.PathLike[str], path: str, after_line: int, text: str) -> str:
    """Insert ``text`` after 1-based line ``after_line`` (0 = top, -1 = end).

    Like edit_file: keeps line endings, refuses unparseable .py results, and
    returns the inserted region, numbered.
    """
    target = resolve_in_root(root, path)
    if not target.is_file():
        raise _not_a_file(root, path, target)
    rel = _rel_of(root, target)
    crlf = _is_crlf(target)
    lines = _to_lf(_read_text(target)).splitlines(keepends=True)
    position = len(lines) if after_line == -1 else after_line
    if not 0 <= position <= len(lines):
        raise ValueError(f"after_line must be between 0 and {len(lines)}, or -1 for the end; got {after_line}")
    new = _to_lf(text)
    if not new:
        raise ValueError("text must not be empty")
    if not new.endswith("\n"):
        new += "\n"
    head = "".join(lines[:position])
    if head and not head.endswith("\n"):
        head += "\n"
    updated = head + new + "".join(lines[position:])
    check_python(rel, updated)
    _write_text(target, updated, crlf)

    count = new.count("\n")
    return (
        f"inserted {count} line(s) into {rel} after line {position}; it now reads:\n"
        + render_region(updated.splitlines(), position + 1, position + count)
    )


def check_python(rel: str, text: str) -> None:
    """Raise InvalidPython if ``rel`` is a .py file and ``text`` does not parse."""
    if not rel.endswith(".py"):
        return
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ast.parse(text, filename=rel)
    except SyntaxError as exc:
        line = exc.lineno or 1
        lines = text.splitlines()
        region = render_region(lines, line, line, context=2) if lines else ""
        raise InvalidPython(
            f"refused: this change would make {rel} invalid Python ({exc.msg} at line {line}); "
            f"the file was not changed. The rejected content around line {line}:\n{region}"
        ) from None
    except ValueError as exc:  # e.g. null bytes
        raise InvalidPython(f"refused: {rel} would not be valid Python ({exc}); the file was not changed") from None


def render_region(
    lines: list[str], first: int, last: int, context: int = REGION_CONTEXT, max_lines: int = MAX_REGION_LINES
) -> str:
    """Numbered lines first..last (1-based) plus context, like read_file output."""
    if not lines:
        return "[file is empty]"
    start = max(1, first - context)
    end = min(len(lines), max(last, first) + context)
    numbers = list(range(start, end + 1))
    if len(numbers) > max_lines:
        half = max_lines // 2
        numbers = numbers[:half] + [None] + numbers[-half:]
    width = len(str(end))
    return "\n".join(
        f"{n:>{width}}| {_clip(lines[n - 1])}" if n is not None else f"{'':>{width}}  […]" for n in numbers
    )


def suggest_paths(root: str | os.PathLike[str], path: str, limit: int = 3) -> list[str]:
    """Existing paths close to ``path``: same file name first, then similar paths."""
    root_path = Path(root).resolve(strict=True)
    wanted = str(path).replace("\\", "/").strip().removeprefix("./").rstrip("/")
    name = PurePosixPath(wanted).name
    candidates: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root_path, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
        rel_dir = Path(dirpath).relative_to(root_path).as_posix()
        prefix = "" if rel_dir == "." else rel_dir + "/"
        candidates.extend(prefix + d for d in dirnames)
        candidates.extend(prefix + f for f in sorted(filenames))
        if len(candidates) > 5000:
            break
    same_name = [c for c in candidates if PurePosixPath(c).name == name]
    close = difflib.get_close_matches(wanted, candidates, n=limit, cutoff=0.6)
    return list(dict.fromkeys(same_name + close))[:limit]


def _not_a_file(root: str | os.PathLike[str], path: str, target: Path) -> OSError:
    if target.is_dir():
        return IsADirectoryError(f"is a directory, not a file: {path}")
    suggestions = suggest_paths(root, path)
    hint = f"; did you mean {' or '.join(suggestions)}?" if suggestions else ""
    return FileNotFoundError(f"no such file: {path}{hint}")


def _not_found_message(rel: str, text: str, old: str) -> str:
    lines = text.splitlines()
    match = _closest_region(lines, old)
    if match is None:
        return f"old text not found in {rel}; read the file and copy the text exactly"
    first, last, ratio = match
    return (
        f"old text not found in {rel}. The closest match is lines {first}-{last} ({ratio:.0%} similar):\n"
        + render_region(lines, first, last, context=2)
        + '\nCopy the exact text from these lines (without the "N| " prefixes) and try again.'
    )


def _closest_region(lines: list[str], old: str) -> tuple[int, int, float] | None:
    """The 1-based line range of ``lines`` most similar to ``old``, and its similarity."""
    old_lines = old.strip("\n").split("\n")
    size = len(old_lines)
    if not lines:
        return None
    matcher = difflib.SequenceMatcher(autojunk=False)
    matcher.set_seq2("\n".join(old_lines))  # seq2 is the one SequenceMatcher caches
    best_ratio, best_start = 0.0, 0
    for start in range(max(1, len(lines) - size + 1)):
        matcher.set_seq1("\n".join(lines[start:start + size]))
        if matcher.real_quick_ratio() <= best_ratio or matcher.quick_ratio() <= best_ratio:
            continue
        ratio = matcher.ratio()
        if ratio > best_ratio:
            best_ratio, best_start = ratio, start
    if best_ratio < 0.3:
        return None
    return best_start + 1, min(len(lines), best_start + size), best_ratio


_LINE_NUMBER_RE = re.compile(r"^\s*\d+\| ?")


def _strip_line_numbers(text: str) -> str | None:
    """``text`` without read_file's "N| " prefixes, or None if it has none."""
    lines = text.split("\n")
    numbered = [line for line in lines if line.strip()]
    if not numbered or not all(_LINE_NUMBER_RE.match(line) for line in numbered):
        return None
    return "\n".join(_LINE_NUMBER_RE.sub("", line, count=1) for line in lines)


def _changed_lines(old: list[str], new: list[str]) -> tuple[int | None, int]:
    """First and last line of ``new`` that differ from ``old`` (1-based)."""
    changed = [
        (j1, j2) for tag, _, _, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes()
        if tag != "equal"
    ]
    if not changed:
        return None, 0
    first = changed[0][0] + 1
    last = max(changed[-1][1], first)
    return min(first, max(len(new), 1)), min(last, max(len(new), 1))


def _rel_of(root: str | os.PathLike[str], target: Path) -> str:
    return target.relative_to(Path(root).resolve(strict=True)).as_posix()


def _read_text(target: Path) -> str:
    with target.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


def _is_crlf(target: Path) -> bool:
    return b"\r\n" in target.read_bytes()


def _to_lf(text: str) -> str:
    return text.replace("\r\n", "\n")


def _write_text(target: Path, text: str, crlf: bool) -> None:
    with target.open("w", encoding="utf-8", newline="") as fh:
        fh.write(text.replace("\n", "\r\n") if crlf else text)


def list_dir(root: str | os.PathLike[str], path: str = ".") -> str:
    """List a directory (non-recursive). Directories end with '/'."""
    target = resolve_in_root(root, path)
    if not target.is_dir():
        if target.exists():
            raise NotADirectoryError(f"not a directory: {path}")
        raise _not_a_file(root, path, target)
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
