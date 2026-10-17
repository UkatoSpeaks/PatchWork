"""The coder agent: fixes a bug in a local repository."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from patchwork.agents.base import Agent, EventCallback, SupportsComplete, Tool, ToolOutput
from patchwork.config import Settings
from patchwork.tools import fs, shell

ROLE = "coder"

SYSTEM_PROMPT = """\
You are the coder agent in Patchwork. You fix bugs in a repository. All paths are relative to the repo root.

Workflow:
1. Locate before reading: use search_code to find the functions, names or error text from the issue. Then read_file only the files (and line ranges, via offset) you need.
2. Find the root cause. Make the smallest change that fixes it. Prefer edit_file over write_file. Do not refactor, reformat, rename or touch unrelated code. Do not change tests unless the issue says they are wrong.
3. Run run_tests after editing. If tests fail, read the failure, fix, and re-run.
4. Call finish with success=true only after tests pass. If you cannot fix it, call finish with success=false and say what blocks you.

Be terse. Do not explain between tool calls; just call the next tool."""


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


class ListDirArgs(BaseModel):
    path: str = "."


class SearchCodeArgs(BaseModel):
    pattern: str = Field(description="Python regex")
    path: str = Field(default=".", description="file or directory to search")
    glob: str | None = Field(default=None, description="file name filter, e.g. *.py")


class RunTestsArgs(BaseModel):
    path: str | None = Field(default=None, description="optional test file, dir or node id; default runs all")


class TestGate:
    """Success counts only if the full suite passed after the last file change."""

    __test__ = False  # not a pytest test class

    def __init__(self) -> None:
        self.verified = False

    def check(self) -> str | None:
        if self.verified:
            return None
        return "the full test suite has not passed since your last edit; call run_tests with no path"


def build_tools(repo: Path, test_command: str, test_timeout: float, gate: TestGate | None = None) -> list[Tool]:
    gate = gate or TestGate()

    def read_file(args: ReadFileArgs) -> ToolOutput:
        text = fs.read_file(repo, args.path, offset=args.offset)
        return ToolOutput(content=text, summary=text.rsplit("\n", 1)[-1].strip("[]"))

    def write_file(args: WriteFileArgs) -> ToolOutput:
        message = fs.write_file(repo, args.path, args.content)
        gate.verified = False
        return ToolOutput(content=message, files_changed=[fs.to_relative(repo, args.path)])

    def edit_file(args: EditFileArgs) -> ToolOutput:
        message = fs.edit_file(repo, args.path, args.old, args.new)
        gate.verified = False
        return ToolOutput(content=message, files_changed=[fs.to_relative(repo, args.path)])

    def list_dir(args: ListDirArgs) -> ToolOutput:
        text = fs.list_dir(repo, args.path)
        return ToolOutput(content=text, summary=f"{len(text.splitlines())} entries")

    def search_code(args: SearchCodeArgs) -> ToolOutput:
        matches = fs.search_code(repo, args.pattern, path=args.path, glob=args.glob)
        if not matches:
            return ToolOutput(content="no matches", summary="no matches")
        lines = [f"{m.path}:{m.line}: {m.text}" for m in matches]
        if len(matches) >= fs.MAX_SEARCH_RESULTS:
            lines.append(f"[capped at {fs.MAX_SEARCH_RESULTS} results; narrow the pattern or path]")
        files = len({m.path for m in matches})
        return ToolOutput(content="\n".join(lines), summary=f"{len(matches)} match(es) in {files} file(s)")

    def run_tests(args: RunTestsArgs) -> ToolOutput:
        extra = []
        if args.path and args.path.strip() not in ("", "."):
            # Allow pytest node ids (file.py::test_name); only the file part is a path.
            file_part, sep, node = args.path.partition("::")
            extra = [fs.to_relative(repo, file_part) + sep + node]
        result = shell.run_tests(repo, test_command, timeout=test_timeout, extra_args=extra)
        if not extra:
            gate.verified = result.passed
        return ToolOutput(content=result.render(), summary=result.summary_line(), is_error=not result.passed)

    return [
        Tool(name="search_code", description="Regex search; returns path:line: text.", args_model=SearchCodeArgs, handler=search_code),
        Tool(name="read_file", description="Read up to 200 numbered lines from offset.", args_model=ReadFileArgs, handler=read_file),
        Tool(name="edit_file", description="Replace one exact occurrence of old with new.", args_model=EditFileArgs, handler=edit_file),
        Tool(name="write_file", description="Create or overwrite a whole file.", args_model=WriteFileArgs, handler=write_file),
        Tool(name="list_dir", description="List a directory.", args_model=ListDirArgs, handler=list_dir),
        Tool(name="run_tests", description="Run the test suite (or one path).", args_model=RunTestsArgs, handler=run_tests),
    ]


def build_coder(
    *,
    repo: Path,
    settings: Settings,
    llm: SupportsComplete,
    test_command: str | None = None,
    on_event: EventCallback | None = None,
) -> Agent:
    repo = Path(repo).resolve(strict=True)
    gate = TestGate()
    return Agent(
        role=ROLE,
        model=settings.model_for(ROLE),
        system_prompt=SYSTEM_PROMPT,
        tools=build_tools(repo, test_command or settings.test_command, settings.test_timeout_seconds, gate),
        verify_finish=gate.check,
        llm=llm,
        max_steps=settings.max_steps_per_agent,
        max_tokens=settings.max_tokens_per_run,
        max_output_tokens=settings.max_output_tokens,
        on_event=on_event,
    )


def build_task(repo: Path, issue: str) -> str:
    """The first user message. Includes the top-level listing to save a step."""
    return f"Issue to fix:\n{issue.strip()}\n\nRepository top level:\n{fs.list_dir(repo, '.')}"
