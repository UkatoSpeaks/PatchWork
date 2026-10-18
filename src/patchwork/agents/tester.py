"""The tester agent: writes new tests that fail until the issue is resolved."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from patchwork.agents.base import Agent, EventCallback, SupportsComplete, Tool
from patchwork.agents.coder import format_subtasks
from patchwork.agents.toolkit import (
    NO_REREAD,
    all_of,
    is_test_module,
    new_files_only,
    read_only_tools,
    run_tests_tool,
    tests_only,
    write_tools,
)
from patchwork.config import Settings
from patchwork.tools import fs, shell

if TYPE_CHECKING:
    from patchwork.schemas import Subtask

ROLE = "tester"

SYSTEM_PROMPT = f"""\
You are the tester agent in Patchwork. The feature or fix described in the issue DOES NOT EXIST YET. You write NEW tests that encode the behaviour the issue asks for; a coder agent implements it afterwards. All paths are relative to the repo root.

Your new tests are SUPPOSED to fail. Because the code is missing, an ImportError or AttributeError for the missing function or name is expected and correct; so is an assertion failure on the old behaviour. That is not your mistake: do not rewrite imports or tests to make that error go away. Your job ends the moment your new tests fail for that reason; Patchwork then finishes your task automatically.

Rules:
- Create a NEW test file, e.g. tests/test_<feature>.py. You may only create test files (under a tests/ directory or named test_*.py). Existing test files must not be changed; edits to them are refused.
- Do not fix or change the code under test.

Workflow:
1. Read one existing test file to match its style and imports. Read the code under test only as far as you need.
2. write_file your new test file, covering the acceptance criteria and edge cases from the issue.
3. run_tests with path set to your new file. If it fails because the feature is missing (or the old behaviour is wrong), you are done. If your tests PASS, they do not capture the issue: rewrite them. Fix only real mistakes in your own file, such as a syntax error or a typo in an existing name.
4. If you cannot write such tests, call finish with success=false.

{NO_REREAD}
Be terse. Do not explain between tool calls; just call the next tool."""

# pytest exit codes
_TESTS_FAILED = 1
_COLLECTION_ERROR = 2
_NO_TESTS = 5
# A collection error from a missing name is how a test for a new feature fails;
# anything else (syntax errors, bad fixtures) means the test itself is broken.
_MISSING_NAME_MARKERS = ("ImportError", "ModuleNotFoundError", "AttributeError")
_BROKEN_TEST_MARKERS = ("SyntaxError", "IndentationError")


class FailingTestGate:
    """Success counts only if the tester's new tests exist and fail before the fix.

    The check runs the tests itself rather than trusting the model's report.
    """

    __test__ = False  # not a pytest test class

    def __init__(self, repo: Path, test_command: str, timeout: float) -> None:
        self.repo = repo
        self.test_command = test_command
        self.timeout = timeout
        self.written: list[str] = []

    def record(self, rel: str) -> None:
        if rel not in self.written:
            self.written.append(rel)

    @property
    def test_files(self) -> list[str]:
        return [p for p in self.written if is_test_module(p) and (self.repo / p).is_file()]

    def check(self) -> str | None:
        files = self.test_files
        if not files:
            return "you have not written any test file (test_*.py) yet"
        result = shell.run_tests(self.repo, self.test_command, timeout=self.timeout, extra_args=files)
        return _must_fail_verdict(result)

    def auto_finish(self, result: shell.RunTestsResult, target: str | None) -> str | None:
        """After a tester run_tests: end the task if the run covered only the
        tester's new files and shows them failing the right way."""
        if target is None or target.partition("::")[0] not in self.test_files:
            return None
        if _must_fail_verdict(result) is not None:
            return None
        return f"tester: fail-first confirmed, auto-finished ({result.summary_line()})"


def _must_fail_verdict(result: shell.RunTestsResult) -> str | None:
    """None if the run shows the new tests failing as they should; otherwise why not."""
    output = result.stdout + result.stderr
    if result.passed:
        return (
            "your new tests PASS without any fix, so they do not capture the issue; "
            "rewrite them so they fail until the issue is resolved"
        )
    if result.timed_out:
        return "your new tests timed out; make them fast and deterministic"
    if result.exit_code == _TESTS_FAILED:
        return None
    if result.exit_code == _COLLECTION_ERROR:
        if any(m in output for m in _MISSING_NAME_MARKERS) and not any(m in output for m in _BROKEN_TEST_MARKERS):
            return None
        return "your new tests could not be collected; fix the test file itself:\n" + shell.truncate_tail(output, 1500)
    if result.exit_code == _NO_TESTS:
        return "no tests were collected from your files; name test functions test_*"
    return f"unexpected test run result: {result.summary_line()}"


def build_tester(
    *,
    repo: Path,
    settings: Settings,
    llm: SupportsComplete,
    test_command: str | None = None,
    on_event: EventCallback | None = None,
) -> Agent:
    repo = Path(repo).resolve(strict=True)
    command = test_command or settings.test_command
    gate = FailingTestGate(repo, command, settings.test_timeout_seconds)
    tools: list[Tool] = [
        *read_only_tools(repo),
        *write_tools(repo, guard=all_of(tests_only, new_files_only(repo, gate.written)), on_change=gate.record),
        run_tests_tool(repo, command, settings.test_timeout_seconds, gate.auto_finish),
    ]
    return Agent(
        role=ROLE,
        model=settings.model_for(ROLE),
        system_prompt=SYSTEM_PROMPT,
        tools=tools,
        verify_finish=gate.check,
        llm=llm,
        max_steps=settings.max_steps_per_agent,
        max_tokens=settings.max_tokens_per_run,
        max_output_tokens=settings.max_output_tokens,
        on_event=on_event,
    )


def build_tester_task(repo: Path, issue: str, subtasks: Sequence[Subtask] = ()) -> str:
    parts = [f"Issue:\n{issue.strip()}"]
    if subtasks:
        parts.append("Your subtasks from the lead's plan:\n" + format_subtasks(subtasks))
    parts.append(f"Repository top level:\n{fs.list_dir(repo, '.')}")
    return "\n\n".join(parts)
