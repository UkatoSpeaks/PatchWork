"""Command-line interface: ``patchwork run --repo PATH --issue TEXT``."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Annotated, Any

import typer

from patchwork.agents.base import AgentEvent, AgentResult
from patchwork.agents.coder import build_coder, build_task
from patchwork.config import Settings
from patchwork.llm import LLMClient

app = typer.Typer(help="Patchwork: a multi-agent coding system.", add_completion=False, no_args_is_help=True)


@app.callback()
def main() -> None:
    """Patchwork CLI."""


@app.command()
def run(
    repo: Annotated[Path, typer.Option(exists=True, file_okay=False, resolve_path=True, help="Path to the local repository.")],
    issue: Annotated[str, typer.Option(help="Description of the bug to fix.")],
    test_cmd: Annotated[str | None, typer.Option(help="Override TEST_COMMAND for this run.")] = None,
    max_steps: Annotated[int | None, typer.Option(min=1, help="Override MAX_STEPS_PER_AGENT.")] = None,
) -> None:
    """Run the coder agent on REPO to fix ISSUE."""
    settings = Settings()
    if max_steps is not None:
        settings = settings.model_copy(update={"max_steps_per_agent": max_steps})
    if settings.coder_model.startswith("groq/") and not settings.api_key():
        typer.secho("GROQ_API_KEY is not set. Copy .env.example to .env and add your key.", fg="red", err=True)
        raise typer.Exit(2)

    typer.secho(f"Patchwork coder | model={settings.coder_model} | repo={repo}", bold=True)
    typer.echo(f"Budget: {settings.max_steps_per_agent} steps, {settings.max_tokens_per_run:,} tokens\n")

    result = asyncio.run(_run_coder(repo, issue, settings, test_cmd))
    _print_result(result, settings)
    raise typer.Exit(0 if result.success else 1)


async def _run_coder(repo: Path, issue: str, settings: Settings, test_cmd: str | None) -> AgentResult:
    llm = LLMClient(
        api_key=settings.api_key(),
        max_concurrency=settings.max_concurrent_requests,
        max_retries=settings.llm_max_retries,
        on_retry=_print_retry,
    )
    agent = build_coder(repo=repo, settings=settings, llm=llm, test_command=test_cmd, on_event=_print_event)
    return await agent.run(build_task(repo, issue))


def _print_event(event: AgentEvent) -> None:
    prefix = f"[step {event.step:>2}]"
    if event.kind == "thought":
        typer.secho(f"{prefix} thinking: {event.summary}", dim=True)
    elif event.kind == "tool_call":
        typer.echo(f"{prefix} {event.tool}({_format_args(event.arguments)})")
        typer.secho(f"          -> {event.summary}", fg="red" if event.is_error else "green")
    elif event.kind == "finish":
        typer.secho(f"{prefix} finish(success={not event.is_error})", bold=True)
    else:
        typer.secho(f"{prefix} {event.summary}", fg="yellow")


def _print_retry(attempt: int, delay: float, exc: BaseException) -> None:
    typer.secho(f"          rate limited; waiting {delay:.1f}s (retry {attempt})", fg="yellow")


def _format_args(arguments: dict[str, Any], limit: int = 40) -> str:
    parts = []
    for key, value in arguments.items():
        text = repr(value)
        if len(text) > limit:
            text = text[: limit - 4] + "…" + text[-3:]
        parts.append(f"{key}={text}")
    return ", ".join(parts)


def _print_result(result: AgentResult, settings: Settings) -> None:
    color = "green" if result.success else "red"
    typer.echo("")
    typer.secho("=== Result ===", bold=True)
    typer.secho(f"success:       {result.success}", fg=color, bold=True)
    typer.echo(f"stop reason:   {result.stop_reason}")
    typer.echo(f"summary:       {result.summary}")
    typer.echo(f"files changed: {', '.join(result.files_changed) or '(none)'}")
    typer.echo(f"steps used:    {result.steps_used}/{settings.max_steps_per_agent}")
    typer.echo(
        f"tokens used:   {result.tokens_used:,} "
        f"(prompt {result.prompt_tokens:,}, completion {result.completion_tokens:,})"
    )


if __name__ == "__main__":
    app()
