"""Runs the crew in a fixed order: lead -> tester -> coder -> reviewer.

Agents run one after another. Each gets only what it needs from earlier
agents (the plan, test file paths, the diff), not their conversation history.
The repo is snapshotted first, and the run's diff and changed files are
computed from that snapshot.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from patchwork.agents.base import Agent, AgentResult, EventCallback, SupportsComplete
from patchwork.agents.coder import build_coder, build_task
from patchwork.agents.lead import build_lead, build_lead_task
from patchwork.agents.reviewer import build_review_task, build_reviewer
from patchwork.agents.tester import build_tester, build_tester_task
from patchwork.agents.toolkit import is_test_module
from patchwork.config import Settings
from patchwork.schemas import Plan, ReviewVerdict, RunResult
from patchwork.snapshot import Snapshot

CREW = ("lead", "tester", "coder", "reviewer")

# (role, model) when an agent starts; (role, run so far) when it is done.
AgentStartCallback = Callable[[str, str], None]
AgentDoneCallback = Callable[[str, RunResult], None]


class Orchestrator:
    def __init__(
        self,
        *,
        repo: Path,
        settings: Settings,
        llm: SupportsComplete,
        test_command: str | None = None,
        on_event: EventCallback | None = None,
        on_agent_start: AgentStartCallback | None = None,
        on_agent_done: AgentDoneCallback | None = None,
    ) -> None:
        self.repo = Path(repo).resolve(strict=True)
        self.settings = settings
        self.llm = llm
        self.test_command = test_command
        self.on_event = on_event
        self.on_agent_start = on_agent_start
        self.on_agent_done = on_agent_done

    async def run(self, issue: str) -> RunResult:
        """The full crew. Success = coder succeeded and reviewer approved."""
        run = RunResult(issue=issue, mode="crew")
        with Snapshot(self.repo) as snapshot:
            try:
                await self._crew(issue, run, snapshot)
            finally:
                self._record_diff(run, snapshot)
        coder = run.agents.get("coder")
        run.success = (
            run.failed_agent is None
            and coder is not None and coder.success
            and run.verdict is not None and run.verdict.approved
        )
        return run

    async def run_solo(self, issue: str) -> RunResult:
        """Only the coder, as in milestone 1. Success = coder succeeded."""
        run = RunResult(issue=issue, mode="solo")
        with Snapshot(self.repo) as snapshot:
            try:
                coder = self._coder()
                result = await self._step(run, "coder", coder, build_task(self.repo, issue))
                self._done("coder", run)
            finally:
                self._record_diff(run, snapshot)
        run.success = result.success
        return run

    async def _crew(self, issue: str, run: RunResult, snapshot: Snapshot) -> None:
        lead = build_lead(repo=self.repo, settings=self.settings, llm=self.llm, on_event=self.on_event)
        result = await self._step(run, "lead", lead, build_lead_task(self.repo, issue))
        if result.success and result.output is not None:
            run.plan = Plan.model_validate(result.output)
        else:
            run.failed_agent = "lead"
        self._done("lead", run)
        if run.failed_agent:
            return
        plan = run.plan

        tester = build_tester(
            repo=self.repo, settings=self.settings, llm=self.llm, test_command=self.test_command, on_event=self.on_event
        )
        result = await self._step(run, "tester", tester, build_tester_task(self.repo, issue, plan.for_role("tester")))
        # The lead cannot write, so everything changed so far is the tester's.
        tester_files = snapshot.changed_files()
        run.tests_written = [p for p in tester_files if is_test_module(p)]
        if not result.success:
            run.failed_agent = "tester"
        self._done("tester", run)
        if run.failed_agent:
            return

        coder = self._coder(protected_files=tester_files)
        task = build_task(self.repo, issue, plan.for_role("coder"), run.tests_written)
        result = await self._step(run, "coder", coder, task)
        if not result.success:
            run.failed_agent = "coder"
        self._done("coder", run)
        if run.failed_agent:
            return

        changes = snapshot.diff()
        reviewer = build_reviewer(repo=self.repo, settings=self.settings, llm=self.llm, on_event=self.on_event)
        task = build_review_task(issue, changes.diff, changes.files_changed, run.tests_written)
        result = await self._step(run, "reviewer", reviewer, task)
        if result.success and result.output is not None:
            run.verdict = ReviewVerdict.model_validate(result.output)
        else:
            run.failed_agent = "reviewer"
        self._done("reviewer", run)

    def _coder(self, protected_files: list[str] | None = None) -> Agent:
        return build_coder(
            repo=self.repo,
            settings=self.settings,
            llm=self.llm,
            test_command=self.test_command,
            protected_files=protected_files or (),
            on_event=self.on_event,
        )

    async def _step(self, run: RunResult, role: str, agent: Agent, task: str) -> AgentResult:
        if self.on_agent_start:
            self.on_agent_start(role, agent.model)
        result = await agent.run(task)
        run.agents[role] = result
        return result

    def _done(self, role: str, run: RunResult) -> None:
        if self.on_agent_done:
            self.on_agent_done(role, run)

    @staticmethod
    def _record_diff(run: RunResult, snapshot: Snapshot) -> None:
        changes = snapshot.diff()
        run.diff = changes.diff
        run.files_changed = changes.files_changed
