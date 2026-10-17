"""Structured data passed between agents and returned by a run."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from patchwork.agents.base import AgentResult


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
    def _check_subtasks(self) -> Plan:
        ids = [s.id for s in self.subtasks]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise ValueError(f"subtask ids must be unique; duplicated: {', '.join(duplicates)}")
        if not self.for_role("coder"):
            raise ValueError('the plan needs at least one subtask with role "coder"')
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
    def _approved_has_no_blockers(self) -> ReviewVerdict:
        if self.approved and any(i.severity == "blocker" for i in self.issues):
            raise ValueError("approved must be false when there is a blocker issue")
        return self


class RunResult(BaseModel):
    """Outcome of one Patchwork run. ``diff`` and ``files_changed`` are computed
    from a snapshot of the repo, never taken from what a model reports."""

    issue: str
    mode: Literal["crew", "solo"] = "crew"
    plan: Plan | None = None
    # Per-agent results in the order the agents ran; agents that never ran are absent.
    agents: dict[str, AgentResult] = Field(default_factory=dict)
    tests_written: list[str] = Field(default_factory=list)
    verdict: ReviewVerdict | None = None
    diff: str = ""
    files_changed: list[str] = Field(default_factory=list)
    success: bool = False
    # The agent that failed and stopped the run, if any.
    failed_agent: str | None = None

    @computed_field
    @property
    def tokens(self) -> dict[str, int]:
        return {role: result.tokens_used for role, result in self.agents.items()}

    @computed_field
    @property
    def total_tokens(self) -> int:
        return sum(self.tokens.values())
