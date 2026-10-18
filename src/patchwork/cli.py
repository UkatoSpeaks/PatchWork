"""Command-line interface.

``patchwork run --repo PATH --issue TEXT [--init-git] [--sequential] [--max-retries N] [--solo]``
``patchwork replay runs/<run_id>/events.jsonl``
``patchwork usage [--days N]``

All output is rendered from run events (see ``render.py``); every run is
also logged to ``runs/<run_id>/events.jsonl`` and ``runs/<run_id>/result.json``.
Only one run at a time is allowed (``runs/.patchwork.lock``); token usage per
model per day accumulates in ``runs/usage.json``.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Annotated

import typer

from patchwork.config import Settings
from patchwork.events import EventBus, JsonlWriter, read_events
from patchwork.llm import LLMClient
from patchwork.orchestrator import CREW, Orchestrator
from patchwork.render import CliRenderer
from patchwork.runlock import RunLocked, run_lock
from patchwork.usage import UsageStore, format_day

app = typer.Typer(help="Patchwork: a multi-agent coding system.", add_completion=False, no_args_is_help=True)

RUNS_DIR = Path("runs")


@app.callback()
def main() -> None:
    """Patchwork CLI."""


def _tolerant_streams() -> None:
    # Model output can contain characters the console encoding lacks; don't crash on them.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")


@app.command()
def run(
    repo: Annotated[Path, typer.Option(exists=True, file_okay=False, resolve_path=True, help="Path to the local repository.")],
    issue: Annotated[str, typer.Option(help="Description of the bug or feature.")],
    init_git: Annotated[bool, typer.Option("--init-git", help="If REPO is not a git repo, run git init and commit everything.")] = False,
    sequential: Annotated[bool, typer.Option("--sequential", help="Run the tester and coder one after the other instead of concurrently.")] = False,
    max_retries: Annotated[int | None, typer.Option(min=0, help="Max coder retries per run (default: MAX_RETRIES, 3).")] = None,
    solo: Annotated[bool, typer.Option("--solo", help="Run only the coder, editing REPO in place (milestone 1 mode).")] = False,
    test_cmd: Annotated[str | None, typer.Option(help="Override TEST_COMMAND for this run.")] = None,
    max_steps: Annotated[int | None, typer.Option(min=1, help="Override MAX_STEPS_PER_AGENT.")] = None,
) -> None:
    """Resolve ISSUE in REPO with the crew, or only the coder with --solo.

    The crew works on git branches patchwork/<run_id>/* in temporary worktrees;
    your working tree is not modified.
    """
    _tolerant_streams()
    settings = Settings()
    if max_steps is not None:
        settings = settings.model_copy(update={"max_steps_per_agent": max_steps})
    roles = ("coder",) if solo else CREW
    if any(settings.model_for(r).startswith("groq/") for r in roles) and not settings.api_key():
        typer.secho("GROQ_API_KEY is not set. Copy .env.example to .env and add your key.", fg="red", err=True)
        raise typer.Exit(2)

    bus = EventBus()
    try:
        with run_lock(RUNS_DIR, bus.run_id):
            bus.subscribe(CliRenderer())
            writer = JsonlWriter(RUNS_DIR / bus.run_id)
            bus.subscribe(writer)
            llm = LLMClient(
                api_key=settings.api_key(),
                max_concurrency=settings.max_concurrent_requests,
                max_wait=settings.llm_max_wait_seconds,
                usage=UsageStore(RUNS_DIR / "usage.json"),
            )
            orchestrator = Orchestrator(
                repo=repo, settings=settings, llm=llm, bus=bus, test_command=test_cmd,
                init_git=init_git, sequential=sequential, max_retries=max_retries,
            )
            result = asyncio.run(orchestrator.run_solo(issue) if solo else orchestrator.run(issue))
    except RunLocked as exc:
        typer.secho(str(exc), fg="red", err=True)
        raise typer.Exit(2) from None
    typer.secho(f"\nEvent log: {writer.events_path}  (replay: patchwork replay {writer.events_path})", dim=True)
    raise typer.Exit(0 if result.success else 1)


@app.command()
def usage(
    days: Annotated[int, typer.Option(min=1, help="Show the last N days that have usage (default: today only).")] = 1,
) -> None:
    """Tokens and requests per model per day, from runs/usage.json."""
    store = UsageStore(RUNS_DIR / "usage.json")
    if days == 1:
        today = store.day()
        if not today:
            typer.echo(f"No usage recorded today ({store.path}).")
            return
        for line in format_day(today):
            typer.echo(line)
        return
    recorded = store.days()[-days:]
    if not recorded:
        typer.echo(f"No usage recorded ({store.path}).")
    for day in recorded:
        typer.secho(day, bold=True)
        for line in format_day(store.day(day), label="total"):
            typer.echo("  " + line)


@app.command()
def replay(
    events: Annotated[Path, typer.Argument(exists=True, dir_okay=False, help="A runs/<run_id>/events.jsonl file.")],
) -> None:
    """Re-render a past run from its event log."""
    _tolerant_streams()
    renderer = CliRenderer()
    for event in read_events(events):
        renderer(event)


if __name__ == "__main__":
    app()
