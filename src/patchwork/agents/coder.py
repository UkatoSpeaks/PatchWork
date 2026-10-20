"""The coder agent: changes the code in a local repository to resolve an issue."""

from __future__ import annotations

from collections.abc import Collection, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from patchwork.agents.base import Agent, EventCallback, SupportsComplete, Tool
from patchwork.agents.toolkit import (
    ALIAS_PREFIXES,
    NO_REREAD,
    TOOL_ALIASES,
    protect,
    read_only_tools,
    repeat_hint,
    run_tests_tool,
    write_tools,
)
from patchwork.config import Settings
from patchwork.tools import fs, shell

if TYPE_CHECKING:
    from patchwork.schemas import Subtask

ROLE = "coder"

# How a crew's tester works alongside the coder: at the same time ("parallel")
# or before it ("sequential"); either way its tests are in another worktree.
TesterMode = Literal["parallel", "sequential"]

SYSTEM_PROMPT = f"""\
You are the coder agent in Patchwork. You fix bugs and implement small features in a repository. All paths are relative to the repo root.

Workflow:
1. Locate before reading: use search_code to find the functions, names or error text from the issue. Then read_file only the files (and line ranges, via offset) you need. Read each file once; its content stays in your context.
2. Find the root cause. Make the smallest change that fixes it. Prefer edit_file over write_file. Do not refactor, reformat, rename or touch unrelated code. Do not change tests unless the issue says they are wrong. Tests written by the tester agent are read-only for you: make them pass by changing the code.
3. To add a new function, use insert_lines with after_line=-1 (end of file) or after the last line of an existing block, starting the text with two blank lines. Never replace an existing `def` line, and do not use a blank line or other non-unique text as an edit_file anchor. If the package's __init__.py re-exports names or defines __all__, export the new name there too.
4. Always run run_tests before finishing. If tests fail, read the failure, fix, and re-run.
5. Call finish with success=true only after the full test suite passes. If you cannot fix it, call finish with success=false and say what blocks you.

{NO_REREAD}
Be terse. Do not explain between tool calls; just call the next tool."""


class TestGate:
    """Success counts only if the full suite passed after the last file change.

    Also nudges the agent when 5 steps have passed since its first edit after
    the last test run.
    """

    __test__ = False  # not a pytest test class
    NUDGE_AFTER_STEPS = 5
    NUDGE = "System note: you edited files 5 steps ago and have not run the tests since. Call run_tests now."
    GIVE_UP_TOO_EARLY = (
        "Not yet: you have not edited any file or run the tests. Explore the repo (list_dir, search_code, "
        "read_file), attempt a fix, and run run_tests. If you still cannot fix it after that, you may give up."
    )

    def __init__(self) -> None:
        self.verified = False
        self.step = 0
        # Step of the first edit since the last test run, if any.
        self.first_untested_edit_step: int | None = None
        self.last_nudge_step = 0
        self.attempted = False
        self.give_up_rejected = False

    def check(self) -> str | None:
        if self.verified:
            return None
        return "the full test suite has not passed since your last edit; call run_tests with no path"

    def give_up_check(self) -> str | None:
        """Refuse one give-up before any edit or test run."""
        if self.attempted or self.give_up_rejected:
            return None
        self.give_up_rejected = True
        return self.GIVE_UP_TOO_EARLY

    def edited(self, rel: str) -> None:
        self.verified = False
        if self.first_untested_edit_step is None:
            self.first_untested_edit_step = self.step
        self.attempted = True

    def tested(self, result: shell.RunTestsResult, target: str | None) -> None:
        if target is None:
            self.verified = result.passed
        self.first_untested_edit_step = None
        self.attempted = True

    def nudge(self, step: int) -> str | None:
        self.step = step
        first = self.first_untested_edit_step
        if first is not None and step - max(first, self.last_nudge_step) > self.NUDGE_AFTER_STEPS:
            self.last_nudge_step = step
            return self.NUDGE
        return None


def build_tools(
    repo: Path,
    test_command: str,
    test_timeout: float,
    gate: TestGate | None = None,
    protected: Collection[str] = (),
) -> list[Tool]:
    """``protected`` paths (root-relative) are refused by edit_file and write_file."""
    gate = gate or TestGate()
    return [
        *read_only_tools(repo),
        *write_tools(repo, guard=protect(protected) if protected else None, on_change=gate.edited),
        run_tests_tool(repo, test_command, test_timeout, gate.tested),
    ]


def build_coder(
    *,
    repo: Path,
    settings: Settings,
    llm: SupportsComplete,
    test_command: str | None = None,
    protected_files: Collection[str] = (),
    retry: bool = False,
    tests_elsewhere: bool = False,
    on_event: EventCallback | None = None,
) -> Agent:
    """``retry``: a crew coder retry, on CODER_RETRY_MODEL and its fallbacks.
    ``tests_elsewhere``: the tester's new tests are in another worktree."""
    repo = Path(repo).resolve(strict=True)
    gate = TestGate()
    model = settings.coder_retry_model_or_default() if retry else settings.model_for(ROLE)
    fallbacks = settings.coder_retry_fallbacks_or_default() if retry else settings.fallbacks_for(ROLE)
    return Agent(
        role=ROLE,
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=build_tools(repo, test_command or settings.test_command, settings.test_timeout_seconds, gate, protected_files),
        verify_finish=gate.check,
        verify_give_up=gate.give_up_check,
        nudge=gate.nudge,
        aliases=TOOL_ALIASES,
        alias_prefixes=ALIAS_PREFIXES,
        fallback_models=fallbacks,
        repeat_hint=repeat_hint(tests_elsewhere),
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
    tester: TesterMode | None = None,
) -> str:
    """The first user message. Includes the top-level listing to save a step.

    ``tester``: in a crew, how the tester works alongside this coder. Its new
    tests are never in this coder's worktree, and the message says so."""
    parts = [f"Issue to fix:\n{issue.strip()}"]
    if subtasks:
        parts.append("Your subtasks from the lead's plan:\n" + format_subtasks(subtasks))
    if tester is not None:
        when = "is writing tests for this issue at the same time" if tester == "parallel" else "has written tests for this issue"
        parts.append(
            f"The tester agent {when}, in a separate workspace. Its new tests will NOT appear in your workspace, "
            "so do not look for them. Implement from the issue and the acceptance criteria above. Check your work "
            "by running the existing test suite with run_tests, plus quick checks of your own if useful (put them "
            "in tests/test_coder_checks.py; the tester uses other file names)."
        )
    if test_files:
        parts.append(
            "Tests written by the tester encode the expected behaviour. They fail now and are read-only "
            "for you; make them pass without breaking other tests:\n" + "\n".join(f"- {p}" for p in test_files)
        )
    parts.append(f"Repository top level:\n{fs.list_dir(repo, '.')}")
    return "\n\n".join(parts)


MAX_RETRY_DIFF_CHARS = 8_000


def build_retry_task(
    repo: Path,
    issue: str,
    subtasks: Sequence[Subtask],
    diff: str,
    feedback: str,
    test_files: Sequence[str] = (),
) -> str:
    """First message for a coder retry: a fresh agent that gets only the plan,
    the work so far (as a diff) and the feedback, not earlier histories."""
    if len(diff) > MAX_RETRY_DIFF_CHARS:
        cut = len(diff) - MAX_RETRY_DIFF_CHARS
        diff = diff[:MAX_RETRY_DIFF_CHARS] + f"\n[… {cut} chars truncated; read the files for the rest]\n"
    parts = [f"Issue to fix:\n{issue.strip()}"]
    if subtasks:
        parts.append("Your subtasks from the lead's plan:\n" + format_subtasks(subtasks))
    parts.append(
        "Earlier work on this issue is already applied in this checkout. Its diff against the original code:\n"
        + (diff or "(no changes yet)")
    )
    parts.append(f"It is not done yet. {feedback.strip()}\nFix this with the smallest change, then run the full test suite.")
    if test_files:
        parts.append(
            "Tests written by the tester encode the expected behaviour and are read-only for you:\n"
            + "\n".join(f"- {p}" for p in test_files)
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
