"""The tester agent: writes new tests that fail until the issue is resolved."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from patchwork.agents.base import Agent, EventCallback, SupportsComplete, Tool
from patchwork.agents.coder import format_subtasks
from patchwork.agents.toolkit import NO_REREAD, is_test_module, read_only_tools, run_tests_tool, tests_only, write_tools
from patchwork.config import Settings
from patchwork.tools import fs, shell

if TYPE_CHECKING:
    from patchwork.schemas import Subtask

ROLE = "tester"

SYSTEM_PROMPT = f"""\
You are the tester agent in Patchwork. Before any fix exists, you write NEW tests that encode the behaviour the issue asks for. A coder agent will then change the code to make them pass. All paths are relative to the repo root.

Rules:
- You may only create or edit test files: files under a tests/ directory or named test_*.py. Other writes are refused.
- Do not fix or change the code under test.

Workflow:
1. Look at the existing tests to match their style and imports. Read the code under test only as far as you need.
2. Write focused tests in a new file such as tests/test_<topic>.py, covering the acceptance criteria and edge cases from the issue. Prefer `import pkg` and calling `pkg.func(...)` inside each test, so a missing function fails the test instead of breaking collection.
3. run_tests on your new file. The tests must FAIL now, because the fix does not exist yet. If they pass, they do not capture the issue: rewrite them.
4. Call finish with success=true once they fail for the right reason. Patchwork re-runs them to check. If you cannot write such tests, call finish with success=false.

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
        *write_tools(repo, guard=tests_only, on_change=gate.record),
        run_tests_tool(repo, command, settings.test_timeout_seconds),
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
