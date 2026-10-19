"""Command-line interface.

``patchwork run --repo PATH (--issue TEXT | --issue-file PATH) [--init-git] [--sequential] [--max-retries N] [--solo]``
``patchwork replay runs/<run_id>/events.jsonl``
``patchwork usage [--days N]``
``patchwork serve [--port 8000] [--runs-dir runs]``

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


def _issue_text(issue: str | None, issue_file: Path | None) -> str:
    """The issue from --issue or --issue-file (exactly one).

    The file is read as UTF-8 (a BOM is fine): passing a file's content through
    the shell, e.g. ``--issue (Get-Content -Raw ISSUE.md)`` in Windows
    PowerShell 5, can decode it with the wrong encoding.
    """
    if (issue is None) == (issue_file is None):
        raise typer.BadParameter("pass exactly one of --issue and --issue-file", param_hint="'--issue' / '--issue-file'")
    if issue_file is None:
        return issue
    try:
        text = issue_file.read_text(encoding="utf-8-sig").strip()
    except (OSError, UnicodeDecodeError) as exc:
        raise typer.BadParameter(f"could not read {issue_file} as UTF-8: {exc}", param_hint="'--issue-file'") from exc
    if not text:
        raise typer.BadParameter(f"{issue_file} is empty", param_hint="'--issue-file'")
    return text


@app.command()
def run(
    repo: Annotated[Path, typer.Option(exists=True, file_okay=False, resolve_path=True, help="Path to the local repository.")],
    issue: Annotated[str | None, typer.Option(help="Description of the bug or feature.")] = None,
    issue_file: Annotated[Path | None, typer.Option(exists=True, dir_okay=False, resolve_path=True,
                                                    help="Read the issue from this UTF-8 file instead of --issue.")] = None,
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
    issue = _issue_text(issue, issue_file)
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
                throttle_mode=settings.throttle_mode,
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


@app.command()
def serve(
    port: Annotated[int, typer.Option(min=1, max=65535, help="Port for the API.")] = 8000,
    host: Annotated[str, typer.Option(help="Interface to bind.")] = "127.0.0.1",
    runs_dir: Annotated[Path, typer.Option(file_okay=False, help="Directory holding runs/<run_id>/events.jsonl.")] = RUNS_DIR,
) -> None:
    """Serve the run logs to the web dashboard (see web/)."""
    import uvicorn

    from patchwork.server import create_app

    typer.echo(f"Patchwork API on http://{host}:{port}/api/runs (runs from {runs_dir.resolve()})")
    uvicorn.run(create_app(runs_dir), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    app()
