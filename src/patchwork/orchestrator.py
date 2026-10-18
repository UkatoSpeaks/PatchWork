"""Runs Patchwork: the crew, or the coder alone (``run_solo``).

Crew flow:
1. plan: the lead reads the main repo (read-only) and submits a Plan.
2. implement: the tester and the coder run concurrently (or one after the
   other with ``sequential``), each in its own git worktree, and commit to
   their own branch.
3. integrate: both branches are merged into a fresh result branch.
4. verify / review: the full suite runs in the result worktree, then the
   reviewer reads the diff. A failing suite or a review blocker starts a
   fresh coder retry in the result worktree, up to ``max_retries`` in total.

Success = the full suite passes in the result worktree and the reviewer
approved. The diff and changed files come from git. Everything observable
is published on the EventBus; nothing here prints.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from patchwork.agents.base import Agent, AgentEvent, EventCallback, SupportsComplete
from patchwork.agents.coder import build_coder, build_retry_task, build_task
from patchwork.agents.lead import build_lead, build_lead_task
from patchwork.agents.reviewer import build_review_task, build_reviewer
from patchwork.agents.tester import build_tester, build_tester_task
from patchwork.agents.toolkit import is_test_module
from patchwork.config import Settings
from patchwork.events import AgentName, EventBus
from patchwork.llm import LLMClient, llm_caller
from patchwork.schemas import AgentRun, Plan, ReviewVerdict, RunResult
from patchwork.snapshot import Snapshot
from patchwork.tools import shell
from patchwork.workspace import MergeConflict, Workspace, WorkspaceError, ensure_repo

CREW = ("lead", "tester", "coder", "reviewer")


class Orchestrator:
    def __init__(
        self,
        *,
        repo: Path,
        settings: Settings,
        llm: SupportsComplete,
        bus: EventBus | None = None,
        test_command: str | None = None,
        init_git: bool = False,
        sequential: bool = False,
        max_retries: int | None = None,
    ) -> None:
        self.repo = Path(repo).resolve(strict=True)
        self.settings = settings
        self.llm = llm
        self.bus = bus or EventBus()
        self.test_command = test_command or settings.test_command
        self.init_git = init_git
        self.sequential = sequential
        self.max_retries = settings.max_retries if max_retries is None else max_retries
        if isinstance(llm, LLMClient):
            llm.on_retry = self._on_rate_limited
            llm.on_cooldown = self._on_cooldown

    @property
    def run_id(self) -> str:
        return self.bus.run_id

    # --- crew -------------------------------------------------------------------

    async def run(self, issue: str) -> RunResult:
        run = RunResult(run_id=self.run_id, issue=issue, mode="crew", sequential=self.sequential)
        self._run_started(run, roles=CREW)
        workspace: Workspace | None = None
        try:
            ensure_repo(self.repo, init_git=self.init_git)
            workspace = Workspace(self.repo, self.run_id)
            run.base_commit = workspace.base
            await self._crew(issue, run, workspace)
        except WorkspaceError as exc:
            run.error = str(exc)
        finally:
            if workspace is not None:
                if workspace.has_branch("result"):
                    run.result_branch = workspace.branch("result")
                    run.diff = workspace.diff("result")
                    run.files_changed = workspace.changed_files("result")
                # Worktrees always go; tester/coder branches only once merged.
                workspace.cleanup(delete_branches=tuple(workspace.merged))
        run.success = (
            run.error is None
            and run.failed_agent is None
            and run.tests_passed is True
            and run.verdict is not None
            and run.verdict.approved
        )
        self._emit("orchestrator", "run_finished", result=run.model_dump(mode="json"))
        return run

    async def _crew(self, issue: str, run: RunResult, workspace: Workspace) -> None:
        plan = await self._plan(issue, run)
        if plan is None:
            return

        with self._phase(run, "implement", parallel=not self.sequential):
            tester_dir = workspace.add_worktree("tester")
            coder_dir = workspace.add_worktree("coder")
            tester_job = self._implement_tester(run, issue, plan, workspace, tester_dir)
            coder_job = self._implement_coder(run, issue, plan, workspace, coder_dir)
            if self.sequential:
                tester_ok = await tester_job
                coder_ok = await coder_job
            else:
                tester_ok, coder_ok = await asyncio.gather(tester_job, coder_job)
        if not tester_ok or not coder_ok:
            run.failed_agent = "tester" if not tester_ok else "coder"
            return

        with self._phase(run, "integrate"):
            result_dir = workspace.add_worktree("result")
            for name in ("coder", "tester"):
                try:
                    files = workspace.merge("result", name)
                except MergeConflict as exc:
                    self._emit("orchestrator", "merge", branch=exc.branch, into=workspace.branch("result"),
                               ok=False, conflicts=exc.files)
                    raise
                self._emit("orchestrator", "merge", branch=workspace.branch(name), into=workspace.branch("result"),
                           ok=True, files=files)
        tester_files = workspace.changed_files("tester")

        review_round = 0
        while True:
            with self._phase(run, "verify"):
                result = shell.run_tests(result_dir, self.test_command, timeout=self.settings.test_timeout_seconds)
                run.tests_passed = result.passed
                self._emit("orchestrator", "tests_run", passed=result.passed, summary=result.summary_line(),
                           reasons=result.failure_reasons(), output=result.render())
            if not result.passed:
                feedback = "The full test suite fails in the merged result:\n" + result.render()
                if not await self._retry(run, issue, plan, workspace, result_dir, "tests", feedback, tester_files):
                    return
                continue

            review_round += 1
            with self._phase(run, "review", round=review_round):
                reviewer = build_reviewer(repo=result_dir, settings=self.settings, llm=self.llm,
                                          on_event=self._forward("reviewer"))
                task = build_review_task(issue, workspace.diff("result"), workspace.changed_files("result"),
                                         run.tests_written)
                label = "reviewer" if review_round == 1 else f"reviewer (round {review_round})"
                entry = await self._run_agent(run, "reviewer", label, reviewer, task)
                if entry.result.success and entry.result.output is not None:
                    run.verdict = ReviewVerdict.model_validate(entry.result.output)
                    self._emit("reviewer", "review_verdict", round=review_round,
                               **run.verdict.model_dump(mode="json"))
                self._agent_finished(entry)
            if run.verdict is None or not entry.result.success:
                run.failed_agent = "reviewer"
                return
            if run.verdict.approved:
                return
            feedback = "The reviewer found problems that must be fixed:\n" + "\n".join(
                f"- [{i.severity}] {i.file}: {i.description}" for i in run.verdict.issues
            )
            if not await self._retry(run, issue, plan, workspace, result_dir, "review", feedback, tester_files):
                return

    async def _plan(self, issue: str, run: RunResult) -> Plan | None:
        with self._phase(run, "plan"):
            lead = build_lead(repo=self.repo, settings=self.settings, llm=self.llm, on_event=self._forward("lead"))
            entry = await self._run_agent(run, "lead", "lead", lead, build_lead_task(self.repo, issue))
            self._agent_finished(entry)
        if entry.result.success and entry.result.output is not None:
            run.plan = Plan.model_validate(entry.result.output)
        else:
            run.failed_agent = "lead"
        return run.plan

    async def _implement_tester(self, run: RunResult, issue: str, plan: Plan, workspace: Workspace, path: Path) -> bool:
        tester = build_tester(repo=path, settings=self.settings, llm=self.llm, test_command=self.test_command,
                              on_event=self._forward("tester"))
        entry = await self._run_agent(run, "tester", "tester", tester, build_tester_task(path, issue, plan.for_role("tester")))
        # Commit even after a failure, so the branch shows what was attempted.
        committed = workspace.commit_all("tester", f"patchwork {self.run_id}: tester")
        run.tests_written = [p for p in workspace.changed_files("tester") if is_test_module(p)]
        self._agent_finished(entry, tests_written=run.tests_written, committed=committed,
                             branch=workspace.branch("tester"))
        return entry.result.success

    async def _implement_coder(self, run: RunResult, issue: str, plan: Plan, workspace: Workspace, path: Path) -> bool:
        # The tester's tests don't exist yet; the coder's check is the existing suite.
        coder = build_coder(repo=path, settings=self.settings, llm=self.llm, test_command=self.test_command,
                            on_event=self._forward("coder"))
        entry = await self._run_agent(run, "coder", "coder", coder, build_task(path, issue, plan.for_role("coder")))
        committed = workspace.commit_all("coder", f"patchwork {self.run_id}: coder")
        self._agent_finished(entry, committed=committed, branch=workspace.branch("coder"),
                             files=workspace.changed_files("coder"))
        return entry.result.success

    async def _retry(
        self,
        run: RunResult,
        issue: str,
        plan: Plan,
        workspace: Workspace,
        path: Path,
        reason: str,
        feedback: str,
        protected: list[str],
    ) -> bool:
        """A fresh coder in the result worktree. False once the retry cap is reached."""
        if run.retries >= self.max_retries:
            self._emit("orchestrator", "note", kind="retry_limit",
                       text=f"retry limit reached ({self.max_retries}); stopping")
            return False
        run.retries += 1
        attempt = run.retries
        self._emit("orchestrator", "retry_started", attempt=attempt, max_retries=self.max_retries,
                   reason=reason, feedback=feedback)
        with self._phase(run, "retry", attempt=attempt, reason=reason):
            coder = build_coder(repo=path, settings=self.settings, llm=self.llm, test_command=self.test_command,
                                protected_files=protected, on_event=self._forward("coder"))
            task = build_retry_task(path, issue, plan.for_role("coder"), workspace.diff("result"), feedback,
                                    run.tests_written)
            entry = await self._run_agent(run, "coder", f"coder (retry {attempt}: {reason})", coder, task)
            committed = workspace.commit_all("result", f"patchwork {self.run_id}: coder retry {attempt} ({reason})")
            self._agent_finished(entry, committed=committed, attempt=attempt, reason=reason)
        return True

    # --- solo -------------------------------------------------------------------

    async def run_solo(self, issue: str) -> RunResult:
        """Only the coder, editing the repo in place as in milestone 1."""
        run = RunResult(run_id=self.run_id, issue=issue, mode="solo")
        self._run_started(run, roles=("coder",))
        with Snapshot(self.repo) as snapshot:
            try:
                with self._phase(run, "implement"):
                    coder = build_coder(repo=self.repo, settings=self.settings, llm=self.llm,
                                        test_command=self.test_command, on_event=self._forward("coder"))
                    entry = await self._run_agent(run, "coder", "coder", coder, build_task(self.repo, issue))
                    self._agent_finished(entry)
            finally:
                changes = snapshot.diff()
                run.diff, run.files_changed = changes.diff, changes.files_changed
        run.success = entry.result.success
        if not run.success:
            run.failed_agent = "coder"
        self._emit("orchestrator", "run_finished", result=run.model_dump(mode="json"))
        return run

    # --- agents and events ---------------------------------------------------------

    async def _run_agent(self, run: RunResult, name: AgentName, label: str, agent: Agent, task: str) -> AgentRun:
        token = llm_caller.set(name)
        self._emit(name, "agent_started", label=label, model=agent.model)
        started = time.monotonic()
        try:
            result = await agent.run(task)
        finally:
            llm_caller.reset(token)
        entry = AgentRun(agent=name, label=label, model=agent.model, result=result,
                         duration_s=round(time.monotonic() - started, 3))
        run.runs.append(entry)
        return entry

    def _agent_finished(self, entry: AgentRun, **extra: Any) -> None:
        result = entry.result
        self._emit(
            entry.agent,  # type: ignore[arg-type]
            "agent_finished",
            label=entry.label,
            model=entry.model,
            success=result.success,
            summary=result.summary,
            stop_reason=result.stop_reason,
            steps=result.steps_used,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
            tokens=result.tokens_used,
            duration_s=entry.duration_s,
            output=result.output,
            **extra,
        )

    def _run_started(self, run: RunResult, roles: tuple[str, ...]) -> None:
        self._emit(
            "orchestrator",
            "run_started",
            issue=run.issue,
            repo=str(self.repo),
            mode=run.mode,
            sequential=run.sequential,
            max_retries=self.max_retries,
            max_steps=self.settings.max_steps_per_agent,
            max_tokens=self.settings.max_tokens_per_run,
            models={role: self.settings.model_for(role) for role in roles},
        )

    @contextmanager
    def _phase(self, run: RunResult, name: str, **info: Any) -> Iterator[None]:
        self._emit("orchestrator", "phase_started", phase=name, **info)
        started = time.monotonic()
        try:
            yield
        finally:
            duration = time.monotonic() - started
            run.phases[name] = round(run.phases.get(name, 0.0) + duration, 3)
            self._emit("orchestrator", "phase_finished", phase=name, duration_s=round(duration, 3), **info)

    def _forward(self, agent: AgentName) -> EventCallback:
        """Turn an agent's AgentEvents into bus events."""

        def forward(event: AgentEvent) -> None:
            if event.kind == "llm_call":
                self._emit(agent, "llm_call", step=event.step, prompt_tokens=event.prompt_tokens,
                           completion_tokens=event.completion_tokens, tokens_used=event.tokens_used)
            elif event.kind == "tool_called":
                self._emit(agent, "tool_called", step=event.step, tool=event.tool, arguments=event.arguments)
            elif event.kind == "tool_result":
                self._emit(agent, "tool_result", step=event.step, tool=event.tool, summary=event.summary,
                           is_error=event.is_error)
            else:  # thought, note, finish
                self._emit(agent, "note", step=event.step, kind=event.kind, tool=event.tool, text=event.summary,
                           is_error=event.is_error)

        return forward

    def _on_rate_limited(self, model: str, attempt: int, delay: float, exc: BaseException) -> None:
        self._emit(llm_caller.get() or "orchestrator", "rate_limited", model=model, delay_s=round(delay, 2),
                   attempt=attempt, shared=False)

    def _on_cooldown(self, model: str, delay: float) -> None:
        self._emit(llm_caller.get() or "orchestrator", "rate_limited", model=model, delay_s=round(delay, 2),
                   shared=True)

    def _emit(self, agent: AgentName, type: str, **payload: Any) -> None:
        self.bus.publish(agent, type, **payload)  # type: ignore[arg-type]
