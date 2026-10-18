"""Tool bindings shared by the agent roles.

Roles pick from three groups: read-only tools (search, read, list), write
tools (edit, write) with an optional guard that refuses some paths, and the
test runner. Restrictions live here, in the tool layer, not only in prompts.
"""

from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Callable, Collection
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import BaseModel, Field

from patchwork.agents.base import Tool, ToolAlias, ToolOutput
from patchwork.tools import fs, shell

# Appended to every role's system prompt.
NO_REREAD = "Never re-read a file you have just written or edited: the tool result already confirms the change."


class ReadFileArgs(BaseModel):
    path: str
    offset: int = Field(default=1, ge=1, description="1-based line to start from")


class WriteFileArgs(BaseModel):
    path: str
    content: str = Field(description="full new file content")


class EditFileArgs(BaseModel):
    path: str
    old: str = Field(description="exact existing text; must occur exactly once")
    new: str = Field(description="replacement text")


class InsertLinesArgs(BaseModel):
    path: str
    after_line: int = Field(ge=-1, description="insert after this 1-based line; 0 = top, -1 = end of file")
    text: str = Field(description="lines to insert")


class ListDirArgs(BaseModel):
    path: str = "."


class SearchCodeArgs(BaseModel):
    pattern: str = Field(description="Python regex")
    path: str = Field(default=".", description="file or directory to search")
    glob: str | None = Field(default=None, description="file name filter, e.g. *.py")


class RunTestsArgs(BaseModel):
    path: str | None = Field(default=None, description="optional test file, dir or node id; default runs all")


def _path_arg(arguments: dict[str, Any]) -> str:
    path = arguments.get("path") or "."
    return str(path).strip() or "."


def _print_tree(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    # list_dir is not recursive, so "depth" has no equivalent and is dropped.
    return "list_dir", {"path": _path_arg(arguments)}


def _open_file(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    # read_file shows up to 200 lines from offset, so line_end is not needed.
    args: dict[str, Any] = {"path": arguments.get("path", "")}
    try:
        args["offset"] = max(1, int(arguments.get("line_start") or 1))
    except (TypeError, ValueError):
        pass
    return "read_file", args


def _search(arguments: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    args: dict[str, Any] = {"pattern": arguments.get("query", arguments.get("pattern", "")), "path": _path_arg(arguments)}
    return "search_code", args


# Tool names gpt-oss was trained on, mapped to ours.
TOOL_ALIASES: dict[str, ToolAlias] = {
    "repo_browser.print_tree": _print_tree,
    "repo_browser.open_file": _open_file,
    "repo_browser.search": _search,
}
# Any other "repo_browser.<tool>" maps to <tool> when that is one of ours.
ALIAS_PREFIXES = ("repo_browser.",)


class WriteNotAllowed(PermissionError):
    """A write the agent's role does not permit."""


# Takes a root-relative POSIX path; raises WriteNotAllowed to refuse the write.
WriteGuard = Callable[[str], None]


def is_test_path(rel: str) -> bool:
    """Under a ``tests/`` directory, or a file named ``test_*.py``."""
    parts = PurePosixPath(rel).parts
    return "tests" in parts[:-1] or (bool(parts) and parts[-1].startswith("test_") and parts[-1].endswith(".py"))


def is_test_module(rel: str) -> bool:
    """A file pytest collects tests from."""
    name = PurePosixPath(rel).name
    return name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py"))


def tests_only(rel: str) -> None:
    """Write guard for the tester: only test files."""
    if not is_test_path(rel):
        raise WriteNotAllowed(
            f"{rel} is not a test file; you may only write files under a tests/ directory or named test_*.py"
        )


tests_only.__test__ = False  # not a pytest test


def new_files_only(repo: Path, created: Collection[str]) -> WriteGuard:
    """Write guard that refuses files which already exist, unless the agent
    created them itself (``created`` is the live collection of its writes)."""

    def guard(rel: str) -> None:
        if (repo / rel).exists() and rel not in created:
            raise WriteNotAllowed(
                f"{rel} already exists; existing tests must not be changed; put new tests in a new file"
            )

    return guard


def all_of(*guards: WriteGuard) -> WriteGuard:
    def guard(rel: str) -> None:
        for check in guards:
            check(rel)

    return guard


def protect(paths: Collection[str], owner: str = "tester") -> WriteGuard:
    """Write guard that refuses the given root-relative paths."""
    blocked = {os.path.normcase(p) for p in paths}

    def guard(rel: str) -> None:
        if os.path.normcase(rel) in blocked:
            raise WriteNotAllowed(
                f"{rel} was written by the {owner} agent and is read-only for you; "
                "change the code under test so these tests pass instead"
            )

    return guard


_READ_SPAN_RE = re.compile(r": lines (\d+)-(\d+) of \d+")


def read_only_tools(repo: Path) -> list[Tool]:
    def read_file(args: ReadFileArgs) -> ToolOutput:
        if fs.resolve_in_root(repo, args.path).is_dir():
            rel = fs.to_relative(repo, args.path)
            text = fs.list_dir(repo, args.path)
            return ToolOutput(
                content=f"{rel} is a directory; its entries:\n{text}",
                summary=f"directory: {len(text.splitlines())} entries",
                view_key=f"list_dir {rel}",
            )
        text = fs.read_file(repo, args.path, offset=args.offset)
        rel = fs.to_relative(repo, args.path)
        span = _READ_SPAN_RE.search(text.rsplit("\n", 1)[-1])
        return ToolOutput(
            content=text,
            summary=text.rsplit("\n", 1)[-1].strip("[]"),
            view_key=f"read_file {rel}",
            view_version=hashlib.sha1(fs.resolve_in_root(repo, rel).read_bytes()).hexdigest(),
            view_span=(int(span.group(1)), int(span.group(2))) if span else None,
        )

    def list_dir(args: ListDirArgs) -> ToolOutput:
        text = fs.list_dir(repo, args.path)
        rel = fs.to_relative(repo, args.path)
        return ToolOutput(content=text, summary=f"{len(text.splitlines())} entries", view_key=f"list_dir {rel}")

    def search_code(args: SearchCodeArgs) -> ToolOutput:
        matches = fs.search_code(repo, args.pattern, path=args.path, glob=args.glob)
        key = f"search_code {args.pattern!r} in {args.path}" + (f" ({args.glob})" if args.glob else "")
        if not matches:
            return ToolOutput(content="no matches", summary="no matches", view_key=key)
        lines = [f"{m.path}:{m.line}: {m.text}" for m in matches]
        if len(matches) >= fs.MAX_SEARCH_RESULTS:
            lines.append(f"[capped at {fs.MAX_SEARCH_RESULTS} results; narrow the pattern or path]")
        files = len({m.path for m in matches})
        return ToolOutput(content="\n".join(lines), summary=f"{len(matches)} match(es) in {files} file(s)", view_key=key)

    return [
        Tool(name="search_code", description="Regex search; returns path:line: text.", args_model=SearchCodeArgs, handler=search_code),
        Tool(name="read_file", description="Read up to 200 numbered lines from offset.", args_model=ReadFileArgs, handler=read_file),
        Tool(name="list_dir", description="List a directory.", args_model=ListDirArgs, handler=list_dir),
    ]


def write_tools(
    repo: Path,
    *,
    guard: WriteGuard | None = None,
    on_change: Callable[[str], None] | None = None,
) -> list[Tool]:
    """edit_file, insert_lines and write_file. ``guard`` sees the normalized
    path before any write; ``on_change`` is told about each path written."""

    def checked(path: str) -> str:
        rel = fs.to_relative(repo, path)
        if guard is not None:
            guard(rel)
        return rel

    def changed(rel: str, message: str) -> ToolOutput:
        if on_change is not None:
            on_change(rel)
        summary = message.split("\n", 1)[0].removesuffix("; it now reads:").rstrip(":")
        if "\nWARNING: " in message:
            summary += " (WARNING: duplicate definition)"
        return ToolOutput(content=message, summary=summary, files_changed=[rel])

    def write_file(args: WriteFileArgs) -> ToolOutput:
        rel = checked(args.path)
        return changed(rel, fs.write_file(repo, rel, args.content))

    def edit_file(args: EditFileArgs) -> ToolOutput:
        rel = checked(args.path)
        return changed(rel, fs.edit_file(repo, rel, args.old, args.new))

    def insert_lines(args: InsertLinesArgs) -> ToolOutput:
        rel = checked(args.path)
        return changed(rel, fs.insert_lines(repo, rel, args.after_line, args.text))

    return [
        Tool(name="edit_file", description="Replace one exact occurrence of old with new.", args_model=EditFileArgs, handler=edit_file),
        Tool(
            name="insert_lines",
            description="Insert text after a line number (0 = top, -1 = end of file).",
            args_model=InsertLinesArgs,
            handler=insert_lines,
        ),
        Tool(name="write_file", description="Create or overwrite a whole file.", args_model=WriteFileArgs, handler=write_file),
    ]


# (result, target) -> optional finish summary. ``target`` is the normalized
# path or node id that was run, or None for the full suite. Returning a string
# ends the agent's run with success.
TestResultHook = Callable[[shell.RunTestsResult, str | None], str | None]


def run_tests_tool(repo: Path, test_command: str, timeout: float, on_result: TestResultHook | None = None) -> Tool:
    def run_tests(args: RunTestsArgs) -> ToolOutput:
        target = None
        if args.path and args.path.strip() not in ("", "."):
            # Allow pytest node ids (file.py::test_name); only the file part is a path.
            file_part, sep, node = args.path.partition("::")
            target = fs.to_relative(repo, file_part) + sep + node
        result = shell.run_tests(repo, test_command, timeout=timeout, extra_args=[target] if target else [])
        finish_summary = on_result(result, target) if on_result is not None else None
        return ToolOutput(
            content=result.render(),
            summary=result.summary_line(),
            is_error=not result.passed,
            finish_summary=finish_summary,
        )

    return Tool(name="run_tests", description="Run the test suite (or one path).", args_model=RunTestsArgs, handler=run_tests)
