"""Structured data passed between agents and returned by a run."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, computed_field, model_validator

from patchwork.agents.base import AgentResult
from patchwork.agents.toolkit import is_test_path


class Subtask(BaseModel):
    # Models often write ids as numbers.
    model_config = ConfigDict(coerce_numbers_to_str=True)

    id: str = Field(description="short id, e.g. t1, c1")
    role: Literal["tester", "coder"]
    description: str
    files_hint: list[str] = Field(default_factory=list, description="paths likely relevant")
    acceptance_criteria: list[str] = Field(default_factory=list, description="checkable statements")


class Plan(BaseModel):
    issue_summary: str
    subtasks: list[Subtask] = Field(min_length=1)
    risks: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check_subtasks(self, info: ValidationInfo) -> Plan:
        ids = [s.id for s in self.subtasks]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise ValueError(f"subtask ids must be unique; duplicated: {', '.join(duplicates)}")
        if not self.for_role("coder"):
            raise ValueError('the plan needs at least one subtask with role "coder"')
        # With context={"repo": path}, tester subtasks must not target existing test files.
        repo = (info.context or {}).get("repo")
        if repo is not None:
            for task in self.for_role("tester"):
                for hint in task.files_hint:
                    rel = hint.replace("\\", "/").strip().removeprefix("./")
                    if is_test_path(rel) and (Path(repo) / rel).is_file():
                        raise ValueError(
                            f"tester subtask {task.id} targets the existing test file {rel}; tester subtasks "
                            "must name a NEW test file such as tests/test_<feature>.py"
                        )
        return self

    def for_role(self, role: str) -> list[Subtask]:
        return [s for s in self.subtasks if s.role == role]


class ReviewIssue(BaseModel):
    severity: Literal["blocker", "minor"]
    file: str
    description: str


class ReviewVerdict(BaseModel):
    approved: bool
    issues: list[ReviewIssue] = Field(default_factory=list)
    summary: str

    @model_validator(mode="after")
    def _approved_means_no_blockers(self) -> ReviewVerdict:
        blockers = self.blockers
        if self.approved and blockers:
            raise ValueError("approved must be false when there is a blocker issue")
        if not self.approved and not blockers:
            raise ValueError(
                "approved must be true when there is no blocker issue; if something must be fixed before "
                'merging, list it with severity "blocker"'
            )
        return self

    @property
    def blockers(self) -> list[ReviewIssue]:
        return [i for i in self.issues if i.severity == "blocker"]


class AgentRun(BaseModel):
    """One agent run within a Patchwork run; retries are separate entries."""

    agent: str
    # e.g. "coder", "coder (retry 1: tests)", "reviewer (round 2)"
    label: str
    # The model the agent started on; ``result.models_used`` has every model it called.
    model: str
    result: AgentResult
    duration_s: float

    @property
    def models(self) -> list[str]:
        return self.result.models_used or [self.model]


class CoderAttempt(BaseModel):
    """One coder attempt in a crew run: the implement-phase coder (attempt 1)
    or a retry (attempt 1 + retry)."""

    attempt: int
    # 0 for the implement-phase coder.
    retry: int = 0
    reason: str | None = None
    # Every model the attempt called, in order (more than one after a switch).
    models: list[str]
    outcome: Literal["passed", "failed", "cancelled"]
    stop_reason: str


class RunResult(BaseModel):
    """Outcome of one Patchwork run. ``diff`` and ``files_changed`` come from
    git (crew: result branch vs the run's base commit) or a snapshot (solo),
    never from what a model reports."""

    run_id: str = ""
    issue: str
    mode: Literal["crew", "solo"] = "crew"
    sequential: bool = False
    plan: Plan | None = None
    # Every agent run in order, including retries.
    runs: list[AgentRun] = Field(default_factory=list)
    tests_written: list[str] = Field(default_factory=list)
    # The latest review verdict.
    verdict: ReviewVerdict | None = None
    retries: int = 0
    # Crew coder attempts in order, with their models. A failed implement-phase
    # attempt counts toward the retry cap.
    attempts: list[CoderAttempt] = Field(default_factory=list)
    # Whether the full suite passed in the result worktree at the end (crew).
    tests_passed: bool | None = None
    diff: str = ""
    files_changed: list[str] = Field(default_factory=list)
    # Branch holding the result (crew), kept after the run for inspection.
    result_branch: str | None = None
    base_commit: str | None = None
    # Branches left in the repo at the end: the result branch, plus (after a
    # failure) the tester/coder branches that have commits.
    kept_branches: list[str] = Field(default_factory=list)
    # Today's usage per model from runs/usage.json at the end of the run:
    # {model: {tokens, requests, tokens_per_day, requests_per_day}}.
    usage_today: dict[str, dict[str, int | None]] = Field(default_factory=dict)
    # Wall-clock seconds per phase (plan, implement, integrate, verify, review, retry).
    phases: dict[str, float] = Field(default_factory=dict)
    success: bool = False
    # The agent that failed and stopped the run, if any.
    failed_agent: str | None = None
    # A run-level problem (not a git repo, merge conflict, ...).
    error: str | None = None

    @property
    def agents(self) -> dict[str, AgentResult]:
        """The latest result of each agent, in the order the agents first ran."""
        latest: dict[str, AgentResult] = {}
        for run in self.runs:
            latest[run.agent] = run.result
        return latest

    @computed_field
    @property
    def tokens(self) -> dict[str, int]:
        """Tokens per agent, summed over its runs (retries included)."""
        totals: dict[str, int] = {}
        for run in self.runs:
            totals[run.agent] = totals.get(run.agent, 0) + run.result.tokens_used
        return totals

    @computed_field
    @property
    def total_tokens(self) -> int:
        return sum(self.tokens.values())
