"""Command-line interface: ``patchwork run --repo PATH --issue TEXT [--solo]``."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Annotated, Any

import typer

from patchwork.agents.base import AgentEvent
from patchwork.config import Settings
from patchwork.llm import LLMClient
from patchwork.orchestrator import CREW, Orchestrator
from patchwork.schemas import RunResult

app = typer.Typer(help="Patchwork: a multi-agent coding system.", add_completion=False, no_args_is_help=True)


@app.callback()
def main() -> None:
    """Patchwork CLI."""


@app.command()
def run(
    repo: Annotated[Path, typer.Option(exists=True, file_okay=False, resolve_path=True, help="Path to the local repository.")],
    issue: Annotated[str, typer.Option(help="Description of the bug or feature.")],
    solo: Annotated[bool, typer.Option("--solo", help="Run only the coder agent (milestone 1 mode).")] = False,
    test_cmd: Annotated[str | None, typer.Option(help="Override TEST_COMMAND for this run.")] = None,
    max_steps: Annotated[int | None, typer.Option(min=1, help="Override MAX_STEPS_PER_AGENT.")] = None,
) -> None:
    """Resolve ISSUE in REPO with the crew (lead -> tester -> coder -> reviewer), or only the coder with --solo."""
    # Model output can contain characters the console encoding lacks; don't crash on them.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    settings = Settings()
    if max_steps is not None:
        settings = settings.model_copy(update={"max_steps_per_agent": max_steps})
    roles = ("coder",) if solo else CREW
    if any(settings.model_for(r).startswith("groq/") for r in roles) and not settings.api_key():
        typer.secho("GROQ_API_KEY is not set. Copy .env.example to .env and add your key.", fg="red", err=True)
        raise typer.Exit(2)

    typer.secho(f"Patchwork {'solo coder' if solo else 'crew'} | repo={repo}", bold=True)
    typer.echo("Models: " + ", ".join(f"{r}={settings.model_for(r)}" for r in roles))
    typer.echo(f"Budget per agent: {settings.max_steps_per_agent} steps, {settings.max_tokens_per_run:,} tokens")

    result = asyncio.run(_run(repo, issue, settings, test_cmd, solo))
    _print_diff(result)
    _print_tokens(result, settings)
    _print_outcome(result)
    raise typer.Exit(0 if result.success else 1)


async def _run(repo: Path, issue: str, settings: Settings, test_cmd: str | None, solo: bool) -> RunResult:
    llm = LLMClient(
        api_key=settings.api_key(),
        max_concurrency=settings.max_concurrent_requests,
        max_retries=settings.llm_max_retries,
        on_retry=_print_retry,
    )
    orchestrator = Orchestrator(
        repo=repo,
        settings=settings,
        llm=llm,
        test_command=test_cmd,
        on_event=_print_event,
        on_agent_start=_print_agent_start,
        on_agent_done=_print_agent_done,
    )
    return await (orchestrator.run_solo(issue) if solo else orchestrator.run(issue))


def _section(title: str) -> None:
    typer.echo("")
    typer.secho(f"=== {title} ===", bold=True)


def _print_agent_start(role: str, model: str) -> None:
    _section(f"{role} ({model})")


def _print_agent_done(role: str, run: RunResult) -> None:
    result = run.agents[role]
    if not result.success:
        typer.secho(f"{role} failed ({result.stop_reason}): {result.summary}", fg="red", bold=True)
        return
    if role == "lead" and run.plan:
        typer.secho(f"Plan: {run.plan.issue_summary}", bold=True)
        for task in run.plan.subtasks:
            typer.echo(f"  [{task.id}] {task.role}: {task.description}")
            if task.files_hint:
                typer.secho(f"       files: {', '.join(task.files_hint)}", dim=True)
            for criterion in task.acceptance_criteria:
                typer.secho(f"       - {criterion}", dim=True)
        for risk in run.plan.risks:
            typer.echo(f"  risk: {risk}")
    elif role == "tester":
        typer.secho(f"Tests written: {', '.join(run.tests_written) or '(none)'}", bold=True)
        typer.echo(f"  {result.summary}")
    elif role == "coder":
        typer.secho(f"Coder: {result.summary}", bold=True)
    elif role == "reviewer" and run.verdict:
        verdict = run.verdict
        label, color = ("APPROVED", "green") if verdict.approved else ("CHANGES REQUESTED", "red")
        typer.secho(f"Verdict: {label}", fg=color, bold=True)
        typer.echo(f"  {verdict.summary}")
        for issue in verdict.issues:
            typer.secho(f"  [{issue.severity}] {issue.file}: {issue.description}", fg="red" if issue.severity == "blocker" else "yellow")


def _print_event(event: AgentEvent) -> None:
    prefix = f"[step {event.step:>2}]"
    if event.kind == "thought":
        typer.secho(f"{prefix} thinking: {event.summary}", dim=True)
    elif event.kind == "tool_call":
        typer.echo(f"{prefix} {event.tool}({_format_args(event.arguments)})")
        typer.secho(f"          -> {event.summary}", fg="red" if event.is_error else "green")
    elif event.kind == "finish":
        typer.secho(f"{prefix} {event.tool}(success={not event.is_error})", bold=True)
    else:
        typer.secho(f"{prefix} {event.summary}", fg="yellow")


def _print_retry(attempt: int, delay: float, exc: BaseException) -> None:
    typer.secho(f"          rate limited; waiting {delay:.1f}s (retry {attempt})", fg="yellow")


def _format_args(arguments: dict[str, Any], limit: int = 40) -> str:
    parts = []
    for key, value in arguments.items():
        text = repr(value)
        if len(text) > limit:
            text = text[: limit - 6] + "..." + text[-3:]
        parts.append(f"{key}={text}")
    return ", ".join(parts)


def _print_diff(result: RunResult) -> None:
    _section(f"Diff (computed from snapshot): {len(result.files_changed)} file(s) changed")
    if not result.diff:
        typer.echo("(no changes)")
        return
    for line in result.diff.splitlines():
        if line.startswith(("+++", "---")):
            typer.secho(line, bold=True)
        elif line.startswith("+"):
            typer.secho(line, fg="green")
        elif line.startswith("-"):
            typer.secho(line, fg="red")
        elif line.startswith("@@"):
            typer.secho(line, fg="cyan")
        else:
            typer.echo(line)


def _print_tokens(result: RunResult, settings: Settings) -> None:
    _section("Tokens")
    rows = [("agent", "model", "steps", "prompt", "completion", "total")]
    for role, agent in result.agents.items():
        rows.append((
            role, settings.model_for(role), f"{agent.steps_used}/{settings.max_steps_per_agent}",
            f"{agent.prompt_tokens:,}", f"{agent.completion_tokens:,}", f"{agent.tokens_used:,}",
        ))
    agents = result.agents.values()
    rows.append((
        "total", "", str(sum(a.steps_used for a in agents)),
        f"{sum(a.prompt_tokens for a in agents):,}", f"{sum(a.completion_tokens for a in agents):,}", f"{result.total_tokens:,}",
    ))
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    for index, row in enumerate(rows):
        cells = [cell.ljust(w) if i < 2 else cell.rjust(w) for i, (cell, w) in enumerate(zip(row, widths))]
        typer.secho("  ".join(cells), bold=index in (0, len(rows) - 1))


def _print_outcome(result: RunResult) -> None:
    _section("Result")
    typer.secho(f"success:       {result.success}", fg="green" if result.success else "red", bold=True)
    if result.failed_agent:
        typer.secho(f"stopped at:    {result.failed_agent} (agent failed)", fg="red")
    elif result.mode == "crew" and result.verdict and not result.verdict.approved:
        typer.secho("stopped at:    reviewer did not approve", fg="red")
    typer.echo(f"files changed: {', '.join(result.files_changed) or '(none)'}")


if __name__ == "__main__":
    app()
