"""The reviewer agent: reads the run's diff and submits a ReviewVerdict."""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from patchwork.agents.base import Agent, EventCallback, SubmitSpec, SupportsComplete
from patchwork.agents.toolkit import NO_REREAD, read_only_tools
from patchwork.config import Settings
from patchwork.schemas import ReviewVerdict

ROLE = "reviewer"
SUBMIT_TOOL = "submit_review"
MAX_DIFF_CHARS = 8_000

SYSTEM_PROMPT = f"""\
You are the reviewer agent in Patchwork. Other agents changed a repository to resolve an issue; you review their unified diff. You cannot edit files, but you can read the repo for context. All paths are relative to the repo root.

Check:
1. Does the diff actually resolve the issue, all of it?
2. Obvious security problems: eval/exec on input, shell injection, unsafe file handling, hard-coded secrets.
3. Unnecessary changes: unrelated edits, refactors, reformatting, debugging leftovers.
4. Style: consistent with the surrounding code, clear names, docstrings where neighbouring code has them.
The full test suite already passes; do not re-check what the tests prove.

Then call {SUBMIT_TOOL} once: approved (true only if there is no blocker), issues (each with severity "blocker" or "minor", file and description) and a short summary. Use "blocker" only for problems that must be fixed before merging.

{NO_REREAD}
Be terse. Do not explain between tool calls; just call the next tool."""


def build_reviewer(*, repo: Path, settings: Settings, llm: SupportsComplete, on_event: EventCallback | None = None) -> Agent:
    repo = Path(repo).resolve(strict=True)
    return Agent(
        role=ROLE,
        model=settings.model_for(ROLE),
        system_prompt=SYSTEM_PROMPT,
        tools=read_only_tools(repo),
        submit=SubmitSpec(name=SUBMIT_TOOL, description="Submit the review verdict. Ends your task.", schema_model=ReviewVerdict),
        llm=llm,
        max_steps=settings.max_steps_per_agent,
        max_tokens=settings.max_tokens_per_run,
        max_output_tokens=settings.max_output_tokens,
        on_event=on_event,
    )


def build_review_task(issue: str, diff: str, files_changed: Sequence[str], test_files: Sequence[str] = ()) -> str:
    if len(diff) > MAX_DIFF_CHARS:
        cut = len(diff) - MAX_DIFF_CHARS
        diff = diff[:MAX_DIFF_CHARS] + f"\n[… {cut} chars truncated; read the files for the rest]\n"
    parts = [
        f"Issue:\n{issue.strip()}",
        "Files changed:\n" + ("\n".join(f"- {p}" for p in files_changed) or "(none)"),
    ]
    if test_files:
        parts.append("New tests written by the tester agent:\n" + "\n".join(f"- {p}" for p in test_files))
    parts.append(f"Unified diff:\n{diff or '(empty)'}")
    return "\n\n".join(parts)
