"""The coder agent: changes the code in a local repository to resolve an issue."""

from __future__ import annotations

from collections.abc import Collection, Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from patchwork.agents.base import Agent, EventCallback, SupportsComplete, Tool
from patchwork.agents.toolkit import NO_REREAD, protect, read_only_tools, run_tests_tool, write_tools
from patchwork.config import Settings
from patchwork.tools import fs

if TYPE_CHECKING:
    from patchwork.schemas import Subtask

ROLE = "coder"

SYSTEM_PROMPT = f"""\
You are the coder agent in Patchwork. You fix bugs and implement small features in a repository. All paths are relative to the repo root.

Workflow:
1. Locate before reading: use search_code to find the functions, names or error text from the issue. Then read_file only the files (and line ranges, via offset) you need.
2. Find the root cause. Make the smallest change that fixes it. Prefer edit_file over write_file. Do not refactor, reformat, rename or touch unrelated code. Do not change tests unless the issue says they are wrong. Tests written by the tester agent are read-only for you: make them pass by changing the code.
3. Run run_tests after editing. If tests fail, read the failure, fix, and re-run.
4. Call finish with success=true only after tests pass. If you cannot fix it, call finish with success=false and say what blocks you.

{NO_REREAD}
Be terse. Do not explain between tool calls; just call the next tool."""


class TestGate:
    """Success counts only if the full suite passed after the last file change."""

    __test__ = False  # not a pytest test class

    def __init__(self) -> None:
        self.verified = False

    def check(self) -> str | None:
        if self.verified:
            return None
        return "the full test suite has not passed since your last edit; call run_tests with no path"


def build_tools(
    repo: Path,
    test_command: str,
    test_timeout: float,
    gate: TestGate | None = None,
    protected: Collection[str] = (),
) -> list[Tool]:
    """``protected`` paths (root-relative) are refused by edit_file and write_file."""
    gate = gate or TestGate()

    def on_change(rel: str) -> None:
        gate.verified = False

    def on_result(result, full_suite: bool) -> None:
        if full_suite:
            gate.verified = result.passed

    return [
        *read_only_tools(repo),
        *write_tools(repo, guard=protect(protected) if protected else None, on_change=on_change),
        run_tests_tool(repo, test_command, test_timeout, on_result),
    ]


def build_coder(
    *,
    repo: Path,
    settings: Settings,
    llm: SupportsComplete,
    test_command: str | None = None,
    protected_files: Collection[str] = (),
    on_event: EventCallback | None = None,
) -> Agent:
    repo = Path(repo).resolve(strict=True)
    gate = TestGate()
    return Agent(
        role=ROLE,
        model=settings.model_for(ROLE),
        system_prompt=SYSTEM_PROMPT,
        tools=build_tools(repo, test_command or settings.test_command, settings.test_timeout_seconds, gate, protected_files),
        verify_finish=gate.check,
        llm=llm,
        max_steps=settings.max_steps_per_agent,
        max_tokens=settings.max_tokens_per_run,
        max_output_tokens=settings.max_output_tokens,
        on_event=on_event,
    )


def build_task(
    repo: Path,
    issue: str,
    subtasks: Sequence[Subtask] = (),
    test_files: Sequence[str] = (),
) -> str:
    """The first user message. Includes the top-level listing to save a step."""
    parts = [f"Issue to fix:\n{issue.strip()}"]
    if subtasks:
        parts.append("Your subtasks from the lead's plan:\n" + format_subtasks(subtasks))
    if test_files:
        parts.append(
            "Tests written by the tester encode the expected behaviour. They fail now and are read-only "
            "for you; make them pass without breaking other tests:\n" + "\n".join(f"- {p}" for p in test_files)
        )
    parts.append(f"Repository top level:\n{fs.list_dir(repo, '.')}")
    return "\n\n".join(parts)


def format_subtasks(subtasks: Sequence[Subtask]) -> str:
    lines = []
    for task in subtasks:
        lines.append(f"[{task.id}] {task.description}")
        if task.files_hint:
            lines.append(f"  files: {', '.join(task.files_hint)}")
        for criterion in task.acceptance_criteria:
            lines.append(f"  - {criterion}")
    return "\n".join(lines)
