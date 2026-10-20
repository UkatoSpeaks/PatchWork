"""Runs Patchwork: the crew, or the coder alone (``run_solo``).

Crew flow:
1. plan: the lead reads the main repo (read-only) and submits a Plan.
2. implement: the tester and the coder run concurrently (or one after the
   other with ``sequential``), each in its own git worktree, and commit to
   their own branch. If the tester fails, the run stops: sequentially the
   coder is not started; in parallel it is cancelled. If the coder fails, the
   tester still finishes and the run goes on; the failed attempt counts
   toward the retry cap.
3. integrate: the coder's branch (if it has commits) and the tester's are
   merged into a fresh result branch.
4. verify / review: the full suite runs in the result worktree, then the
   reviewer reads the diff. A failing suite or a review blocker starts a
   fresh coder retry in the result worktree (on CODER_RETRY_MODEL), up to
   ``max_retries`` in total.

Success = the full suite passes in the result worktree and the reviewer
approved. The diff and changed files come from git. Worktrees are always
removed; a failed run keeps the branches that have commits for inspection.
Everything observable is published on the EventBus; nothing here prints.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Coroutine, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from patchwork.agents.base import Agent, AgentEvent, AgentResult, EventCallback, SupportsComplete
from patchwork.agents.coder import build_coder, build_retry_task, build_task
from patchwork.agents.lead import build_lead, build_lead_task
from patchwork.agents.reviewer import build_review_task, build_reviewer
from patchwork.agents.tester import build_tester, build_tester_task
from patchwork.agents.toolkit import is_test_module
from patchwork.config import Settings
from patchwork.events import AgentName, EventBus
from patchwork.llm import LLMClient, llm_caller
from patchwork.schemas import AgentRun, CoderAttempt, Plan, ReviewVerdict, RunResult
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
        # Agents the orchestrator is cancelling (their sibling failed).
        self._cancelling: set[str] = set()
        # Models whose proportional-throttling fallback has been announced.
        self._throttle_fallbacks: set[str] = set()
        if isinstance(llm, LLMClient):
            llm.on_retry = self._on_rate_limited
            llm.on_cooldown = self._on_cooldown
            llm.on_throttle = self._on_throttle
            llm.on_throttle_fallback = self._on_throttle_fallback

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
            run.success = (
                run.error is None
                and run.failed_agent is None
                and run.tests_passed is True
                and run.verdict is not None
                and run.verdict.approved
            )
            if workspace is not None:
                self._finish_workspace(run, workspace)
        run.usage_today = self._usage_today()
        self._emit("orchestrator", "run_finished", result=run.model_dump(mode="json"))
        return run

    def _finish_workspace(self, run: RunResult, workspace: Workspace) -> None:
        """Remove the worktrees. Keep the branches with commits, except the
        tester/coder branches of a successful run (merged into the result)."""
        names = ("tester", "coder", "result")
        keep = [n for n in names if workspace.has_commits(n) and not (run.success and n in workspace.merged)]
        if "result" in keep:
            run.result_branch = workspace.branch("result")
            run.diff = workspace.diff("result")
            run.files_changed = workspace.changed_files("result")
        run.kept_branches = [workspace.branch(n) for n in keep]
        workspace.cleanup(delete_branches=tuple(n for n in names if n not in keep))

    def _usage_today(self) -> dict[str, dict[str, Any]]:
        store = getattr(self.llm, "usage", None)
        return store.day() if store is not None else {}

    async def _crew(self, issue: str, run: RunResult, workspace: Workspace) -> None:
        plan = await self._plan(issue, run)
        if plan is None:
            return

        with self._phase(run, "implement", parallel=not self.sequential):
            tester_dir = workspace.add_worktree("tester")
            if self.sequential:
                if not await self._implement_tester(run, issue, plan, workspace, tester_dir):
                    run.failed_agent = "tester"
                    self._emit("orchestrator", "note", kind="stopped", text="the tester failed; not starting the coder")
                    return
                coder_dir = workspace.add_worktree("coder")
                coder_ok = await self._implement_coder(run, issue, plan, workspace, coder_dir)
            else:
                coder_dir = workspace.add_worktree("coder")
                ok = await self._run_concurrently({
                    "tester": self._implement_tester(run, issue, plan, workspace, tester_dir),
                    "coder": self._implement_coder(run, issue, plan, workspace, coder_dir),
                }, fatal="tester")
                if not ok["tester"]:
                    run.failed_agent = "tester"
                    return
                coder_ok = ok["coder"]
            if not coder_ok:
                self._coder_failed(run)

        with self._phase(run, "integrate"):
            result_dir = workspace.add_worktree("result")
            for name in ("coder", "tester"):
                if name == "coder" and not workspace.has_commits("coder"):
                    self._emit("orchestrator", "note", kind="merge_skipped",
                               text="the coder committed nothing; merging only the tester's branch")
                    continue
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

    async def _run_concurrently(self, jobs: dict[str, Coroutine[Any, Any, bool]], fatal: str) -> dict[str, bool]:
        """Run the jobs concurrently and return each one's success. When the
        ``fatal`` job fails, cancel the rest (each records and commits what it
        did; they count as failed). Other failures let the rest finish."""
        tasks = {asyncio.create_task(job): name for name, job in jobs.items()}
        pending = set(tasks)
        ok: dict[str, bool] = {}
        try:
            while pending and ok.get(fatal) is not False:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                ok.update((tasks[t], t.result()) for t in done)
            if pending:
                others = ", ".join(sorted(tasks[t] for t in pending))
                self._emit("orchestrator", "note", kind="cancelled", text=f"the {fatal} failed; cancelling the {others}")
        finally:
            # Also on an error or our own cancellation: never leave a sibling running.
            for task in pending:
                self._cancelling.add(tasks[task])
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            self._cancelling.clear()
        return {name: ok.get(name, False) for name in jobs}

    def _coder_failed(self, run: RunResult) -> None:
        """The implement-phase coder failed but the tester succeeded: go on to
        integrate and the retry loop; the failed attempt counts as a retry."""
        failed = next(r for r in reversed(run.runs) if r.agent == "coder").result
        reason = f"{failed.stop_reason}: {_clip(failed.summary)}"
        left = self.max_retries - self._retries_used(run)
        text = (f"coder failed ({reason}); continuing with a retry" if left > 0
                else f"coder failed ({reason}); no retries left, checking the merged result anyway")
        self._emit("orchestrator", "note", kind="coder_failed", text=text, stop_reason=failed.stop_reason,
                   retries_left=max(0, left))

    @staticmethod
    def _retries_used(run: RunResult) -> int:
        """Retries so far, plus a failed implement-phase coder attempt."""
        return run.retries + sum(1 for a in run.attempts if a.retry == 0 and a.outcome != "passed")

    def _record_attempt(self, run: RunResult, entry: AgentRun, retry: int = 0, reason: str | None = None) -> None:
        result = entry.result
        outcome = "cancelled" if result.stop_reason == "cancelled" else "passed" if result.success else "failed"
        run.attempts.append(CoderAttempt(attempt=len(run.attempts) + 1, retry=retry, reason=reason,
                                         models=entry.models, outcome=outcome, stop_reason=result.stop_reason))

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
        # The tester's tests are in its own worktree; the coder's check is the existing suite.
        coder = build_coder(repo=path, settings=self.settings, llm=self.llm, test_command=self.test_command,
                            tests_elsewhere=True, on_event=self._forward("coder"))
        task = build_task(path, issue, plan.for_role("coder"), tester="sequential" if self.sequential else "parallel")
        entry = await self._run_agent(run, "coder", "coder", coder, task, attempt=1)
        self._record_attempt(run, entry)
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
        """A fresh coder (on CODER_RETRY_MODEL) in the result worktree. False once
        the retry cap is reached; a failed implement-phase coder counts toward it."""
        if self._retries_used(run) >= self.max_retries:
            self._emit("orchestrator", "note", kind="retry_limit",
                       text=f"retry limit reached ({self.max_retries}); stopping")
            return False
        run.retries += 1
        attempt = run.retries
        self._emit("orchestrator", "retry_started", attempt=attempt, max_retries=self.max_retries,
                   reason=reason, feedback=feedback)
        with self._phase(run, "retry", attempt=attempt, reason=reason):
            coder = build_coder(repo=path, settings=self.settings, llm=self.llm, test_command=self.test_command,
                                protected_files=protected, retry=True, on_event=self._forward("coder"))
            task = build_retry_task(path, issue, plan.for_role("coder"), workspace.diff("result"), feedback,
                                    run.tests_written)
            escalated = coder.model != self.settings.model_for("coder")
            entry = await self._run_agent(run, "coder", f"coder (retry {attempt}: {reason})", coder, task,
                                          attempt=len(run.attempts) + 1, retry=attempt, escalated=escalated)
            self._record_attempt(run, entry, retry=attempt, reason=reason)
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
        run.usage_today = self._usage_today()
        self._emit("orchestrator", "run_finished", result=run.model_dump(mode="json"))
        return run

    # --- agents and events ---------------------------------------------------------

    async def _run_agent(
        self, run: RunResult, name: AgentName, label: str, agent: Agent, task: str, **info: Any
    ) -> AgentRun:
        """Run ``agent``. If the orchestrator cancels it (see ``_run_concurrently``),
        the run so far is returned as a failure with stop reason "cancelled".
        ``info`` is added to the agent_started event."""
        token = llm_caller.set(name)
        model = agent.model
        self._emit(name, "agent_started", label=label, model=model, **info)
        started = time.monotonic()
        try:
            result = await agent.run(task)
        except asyncio.CancelledError:
            if name not in self._cancelling:
                raise
            asyncio.current_task().uncancel()
            summary = "cancelled: the other implement-phase agent failed"
            if agent.partial_result is not None:
                result = agent.partial_result(summary, "cancelled")
            else:
                result = AgentResult(role=name, success=False, summary=summary, files_changed=[], steps_used=0,
                                     tokens_used=0, prompt_tokens=0, completion_tokens=0, stop_reason="cancelled")
        finally:
            llm_caller.reset(token)
        entry = AgentRun(agent=name, label=label, model=model, result=result,
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
            models_used=entry.models,
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
            **({"coder_retry_model": self.settings.coder_retry_model_or_default()} if run.mode == "crew" else {}),
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
            elif event.kind == "model_switch":
                self._emit(agent, "note", step=event.step, kind="model_switch", text=event.summary,
                           is_error=event.is_error, from_model=event.arguments.get("from"),
                           to_model=event.arguments.get("to"), reason=event.arguments.get("reason"))
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

    def _on_throttle(self, model: str, delay: float, needed: int, remaining: int, limit: int, mode: str) -> None:
        self._emit(llm_caller.get() or "orchestrator", "throttled", model=model, delay_s=round(delay, 2),
                   needed_tokens=needed, remaining_tokens=remaining, limit_tokens=limit, mode=mode)

    def _on_throttle_fallback(self, model: str) -> None:
        if model in self._throttle_fallbacks:
            return
        self._throttle_fallbacks.add(model)
        self._emit("orchestrator", "note", text=f"proportional throttling not accepted on {model}; using full reset waits")

    def _emit(self, agent: AgentName, type: str, **payload: Any) -> None:
        self.bus.publish(agent, type, **payload)  # type: ignore[arg-type]


def _clip(text: str, limit: int = 120) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 3] + "..."
