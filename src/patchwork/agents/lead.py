"""The lead agent: explores the repo read-only and submits a Plan."""

from __future__ import annotations

from pathlib import Path

from patchwork.agents.base import Agent, EventCallback, SubmitSpec, SupportsComplete
from patchwork.agents.toolkit import ALIAS_PREFIXES, NO_REREAD, TOOL_ALIASES, read_only_tools
from patchwork.config import Settings
from patchwork.schemas import Plan
from patchwork.tools import fs

ROLE = "lead"
SUBMIT_TOOL = "submit_plan"

SYSTEM_PROMPT = f"""\
You are the lead agent in Patchwork. You plan how to resolve an issue in a repository. After you, a tester agent writes tests that fail until the issue is resolved, then a coder agent changes the code. You cannot edit files. All paths are relative to the repo root.

Workflow:
1. Explore briefly: search_code for names from the issue, then read_file only what you need. A few files is usually enough.
2. Call {SUBMIT_TOOL} once with:
   - issue_summary: one or two sentences.
   - subtasks: one "tester" subtask (the behaviour the new tests must check) and one or more "coder" subtasks (the code changes). Each has a short id (t1, c1, ...), a description, files_hint (paths likely involved) and acceptance_criteria (checkable statements).
     The tester subtask ALWAYS targets a NEW test file, e.g. tests/test_<feature>.py, never an existing test file: the tester may not change existing tests. Its files_hint may also name the source files under test.
   - risks: edge cases or ways the change could go wrong.
If the plan is rejected, fix what the error says and call {SUBMIT_TOOL} again.

{NO_REREAD}
Be terse. Do not explain between tool calls; just call the next tool."""


def build_lead(*, repo: Path, settings: Settings, llm: SupportsComplete, on_event: EventCallback | None = None) -> Agent:
    repo = Path(repo).resolve(strict=True)
    return Agent(
        role=ROLE,
        model=settings.model_for(ROLE),
        system_prompt=SYSTEM_PROMPT,
        tools=read_only_tools(repo),
        aliases=TOOL_ALIASES,
        alias_prefixes=ALIAS_PREFIXES,
        fallback_models=settings.fallbacks_for(ROLE),
        submit=SubmitSpec(
            name=SUBMIT_TOOL,
            description="Submit the plan. Ends your task.",
            schema_model=Plan,
            summary_field="issue_summary",
            context={"repo": repo},
        ),
        llm=llm,
        max_steps=settings.max_steps_per_agent,
        max_tokens=settings.max_tokens_per_run,
        max_output_tokens=settings.max_output_tokens,
        on_event=on_event,
    )


def build_lead_task(repo: Path, issue: str) -> str:
    return f"Issue:\n{issue.strip()}\n\nRepository top level:\n{fs.list_dir(repo, '.')}"
