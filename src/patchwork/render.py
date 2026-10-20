"""Terminal rendering of run events.

``CliRenderer`` is an EventBus subscriber; it renders only from event
contents, so ``patchwork replay`` reproduces a run's output exactly. Lines
from agents are prefixed with the agent name so parallel output stays
readable.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import typer

from patchwork.events import Event
from patchwork.usage import format_day

Style = dict[str, Any]  # typer.secho keyword arguments: fg, bold, dim
Sink = Callable[[str, Style], None]

PHASE_TITLES = {
    "plan": "plan: lead",
    "integrate": "integrate: merge coder + tester into the result branch",
    "verify": "verify: full test suite in the result worktree",
}


def typer_sink(text: str, style: Style) -> None:
    typer.secho(text, **style)


class ListSink:
    """Collects plain lines, for tests and comparisons."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def __call__(self, text: str, style: Style) -> None:
        self.lines.append(text)


class CliRenderer:
    def __init__(self, sink: Sink = typer_sink) -> None:
        self.sink = sink
        self.max_steps: int | None = None
        self.max_retries: int | None = None
        self.mode = "crew"

    def __call__(self, event: Event) -> None:
        handler = getattr(self, f"_on_{event.type}", None)
        if handler is not None:
            handler(event, event.payload)

    # --- helpers --------------------------------------------------------------

    def _line(self, text: str = "", **style: Any) -> None:
        self.sink(text, style)

    def _agent(self, event: Event, text: str, **style: Any) -> None:
        self._line(f"{event.agent:<8}| {text}", **style)

    def _section(self, title: str) -> None:
        self._line()
        self._line(f"=== {title} ===", bold=True)

    # --- run / phases ---------------------------------------------------------

    def _on_run_started(self, event: Event, p: dict[str, Any]) -> None:
        self.max_steps = p.get("max_steps")
        self.max_retries = p.get("max_retries")
        self.mode = p.get("mode", "crew")
        if self.mode == "solo":
            self._line(f"Patchwork solo coder | run {event.run_id} | repo={p['repo']}", bold=True)
        else:
            how = "sequential" if p.get("sequential") else "parallel"
            self._line(f"Patchwork crew ({how}) | run {event.run_id} | repo={p['repo']}", bold=True)
        models = p.get("models", {})
        line = "Models: " + ", ".join(f"{role}={model}" for role, model in models.items())
        retry_model = p.get("coder_retry_model")
        if retry_model and retry_model != models.get("coder"):
            line += f", coder retries={retry_model}"
        self._line(line)
        budget = f"Budget per agent: {p.get('max_steps')} steps, {p.get('max_tokens', 0):,} tokens"
        if self.mode == "crew":
            budget += f"; up to {p.get('max_retries')} coder retries"
        self._line(budget)

    def _on_phase_started(self, event: Event, p: dict[str, Any]) -> None:
        phase = p["phase"]
        if phase == "implement":
            if self.mode == "solo":
                title = "implement: coder"
            else:
                title = "implement: tester + coder " + ("in parallel" if p.get("parallel") else "one after the other")
        elif phase == "review":
            title = f"review (round {p.get('round', 1)})"
        elif phase == "retry":
            title = f"retry {p.get('attempt')}/{self.max_retries}: coder fixes {p.get('reason')}"
        else:
            title = PHASE_TITLES.get(phase, phase)
        self._section(title)

    def _on_phase_finished(self, event: Event, p: dict[str, Any]) -> None:
        self._line(f"--- {p['phase']} took {p['duration_s']:.1f}s", dim=True)

    # --- agents ---------------------------------------------------------------

    def _on_agent_started(self, event: Event, p: dict[str, Any]) -> None:
        self._agent(event, f"started {p['label']} ({p['model']})", bold=True)

    def _on_tool_called(self, event: Event, p: dict[str, Any]) -> None:
        self._agent(event, f"[step {p['step']:>2}] {p['tool']}({format_args(p.get('arguments') or {})})")

    def _on_tool_result(self, event: Event, p: dict[str, Any]) -> None:
        self._agent(event, f"          -> {p['summary']}", fg="red" if p.get("is_error") else "green")

    def _on_note(self, event: Event, p: dict[str, Any]) -> None:
        kind = p.get("kind")
        if event.agent == "orchestrator":
            self._line(p.get("text", ""), fg="yellow")
        elif kind == "thought":
            self._agent(event, f"[step {p['step']:>2}] thinking: {p['text']}", dim=True)
        elif kind == "finish":
            self._agent(event, f"[step {p['step']:>2}] {p.get('tool') or 'finish'}(success={not p.get('is_error')})", bold=True)
        else:
            self._agent(event, f"[step {p['step']:>2}] {p['text']}", fg="red" if p.get("is_error") else "yellow")

    def _on_rate_limited(self, event: Event, p: dict[str, Any]) -> None:
        why = "waiting out a shared cooldown" if p.get("shared") else f"rate limited (retry {p.get('attempt')})"
        self._agent(event, f"          {why} on {p['model']}: {p['delay_s']:.1f}s", fg="yellow")

    def _on_throttled(self, event: Event, p: dict[str, Any]) -> None:
        self._agent(event, f"          throttling: waiting {p['delay_s']:.1f}s for the token budget on {p['model']} "
                           f"(need ~{p['needed_tokens']:,}, {p['remaining_tokens']:,} left{_throttle_inputs(p)})", fg="yellow")

    def _on_agent_finished(self, event: Event, p: dict[str, Any]) -> None:
        stats = f"({p['duration_s']:.1f}s, {p['steps']} steps, {p['tokens']:,} tokens)"
        models = p.get("models_used") or []
        if len(models) > 1:
            stats += f" [models: {' -> '.join(models)}]"
        if not p["success"]:
            self._agent(event, f"{p['label']} failed ({p['stop_reason']}): {p['summary']} {stats}", fg="red", bold=True)
            return
        if event.agent == "lead" and p.get("output"):
            plan = p["output"]
            self._agent(event, f"Plan: {plan['issue_summary']}", bold=True)
            for task in plan["subtasks"]:
                self._agent(event, f"  [{task['id']}] {task['role']}: {task['description']}")
                if task.get("files_hint"):
                    self._agent(event, f"       files: {', '.join(task['files_hint'])}", dim=True)
                for criterion in task.get("acceptance_criteria", []):
                    self._agent(event, f"       - {criterion}", dim=True)
            for risk in plan.get("risks", []):
                self._agent(event, f"  risk: {risk}")
        elif event.agent == "tester":
            self._agent(event, f"Tests written: {', '.join(p.get('tests_written') or []) or '(none)'}", bold=True)
            self._agent(event, f"  {p['summary']}")
        elif event.agent == "coder":
            self._agent(event, f"Coder: {p['summary']}", bold=True)
        self._agent(event, f"finished {p['label']} {stats}", dim=True)

    # --- orchestrator ---------------------------------------------------------

    def _on_merge(self, event: Event, p: dict[str, Any]) -> None:
        if p.get("ok"):
            files = ", ".join(p.get("files") or []) or "no changes"
            self._line(f"merged {p['branch']} -> {p['into']}: {files}", fg="green")
        else:
            self._line(f"merge of {p['branch']} CONFLICTED in: {', '.join(p.get('conflicts') or [])}", fg="red", bold=True)

    def _on_tests_run(self, event: Event, p: dict[str, Any]) -> None:
        self._line(f"full suite: {p['summary']}", fg="green" if p["passed"] else "red", bold=True)
        for reason in p.get("reasons") or []:
            self._line(f"  reason: {reason}", fg="red")

    def _on_retry_started(self, event: Event, p: dict[str, Any]) -> None:
        why = "the full suite fails" if p["reason"] == "tests" else "the reviewer found blockers"
        self._line(f"starting coder retry {p['attempt']}/{p['max_retries']}: {why}", fg="yellow", bold=True)

    def _on_review_verdict(self, event: Event, p: dict[str, Any]) -> None:
        label, color = ("APPROVED", "green") if p["approved"] else ("CHANGES REQUESTED", "red")
        self._agent(event, f"Verdict: {label}", fg=color, bold=True)
        self._agent(event, f"  {p['summary']}")
        for issue in p.get("issues", []):
            color = "red" if issue["severity"] == "blocker" else "yellow"
            self._agent(event, f"  [{issue['severity']}] {issue['file']}: {issue['description']}", fg=color)

    def _on_run_finished(self, event: Event, p: dict[str, Any]) -> None:
        result = p["result"]
        self._render_diff(result)
        self._render_table(result)
        self._render_outcome(result)

    # --- final sections ---------------------------------------------------------

    def _render_diff(self, result: dict[str, Any]) -> None:
        source = "git: result branch vs base" if result["mode"] == "crew" else "snapshot"
        self._section(f"Diff ({source}): {len(result['files_changed'])} file(s) changed")
        if not result["diff"]:
            self._line("(no changes)")
            return
        for line in result["diff"].splitlines():
            if line.startswith(("+++", "---")):
                self._line(line, bold=True)
            elif line.startswith("+"):
                self._line(line, fg="green")
            elif line.startswith("-"):
                self._line(line, fg="red")
            elif line.startswith("@@"):
                self._line(line, fg="cyan")
            else:
                self._line(line)

    def _render_table(self, result: dict[str, Any]) -> None:
        self._section("Agents: tokens and time")
        rows = [("agent", "model", "steps", "prompt", "avg prompt", "completion", "total", "time")]
        runs = result["runs"]
        limit = f"/{self.max_steps}" if self.max_steps else ""
        for run in runs:
            r = run["result"]
            rows.append((
                run["label"], " -> ".join(r.get("models_used") or [run["model"]]), f"{r['steps_used']}{limit}",
                f"{r['prompt_tokens']:,}", _average(r["prompt_tokens"], r.get("llm_calls")),
                f"{r['completion_tokens']:,}", f"{r['tokens_used']:,}", f"{run['duration_s']:.1f}s",
            ))
        prompt_total = sum(r["result"]["prompt_tokens"] for r in runs)
        calls = sum(r["result"].get("llm_calls") or 0 for r in runs)
        rows.append((
            "total", "", str(sum(r["result"]["steps_used"] for r in runs)),
            f"{prompt_total:,}", _average(prompt_total, calls),
            f"{sum(r['result']['completion_tokens'] for r in runs):,}",
            f"{result['total_tokens']:,}", f"{sum(r['duration_s'] for r in runs):.1f}s",
        ))
        widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
        for index, row in enumerate(rows):
            cells = [cell.ljust(w) if i < 2 else cell.rjust(w) for i, (cell, w) in enumerate(zip(row, widths))]
            self._line("  ".join(cells), bold=index in (0, len(rows) - 1))
        attempts = result.get("attempts") or []
        if attempts:
            self._line("coder: " + " -> ".join(_format_attempt(a) for a in attempts))
        if result["phases"]:
            self._line("Phases: " + " | ".join(f"{name} {secs:.1f}s" for name, secs in result["phases"].items()))
        usage = result.get("usage_today") or {}
        if usage:
            self._line("Usage today (all runs, runs/usage.json):")
            for line in format_day(usage):
                self._line("  " + line)

    def _render_outcome(self, result: dict[str, Any]) -> None:
        self._section("Result")
        self._line(f"success:       {result['success']}", fg="green" if result["success"] else "red", bold=True)
        if result.get("error"):
            self._line(f"error:         {result['error']}", fg="red")
        elif result.get("failed_agent"):
            self._line(f"stopped at:    {result['failed_agent']} (agent failed)", fg="red")
            failed = [r for r in result["runs"] if r["agent"] == result["failed_agent"]]
            if failed:
                r = failed[-1]["result"]
                self._line(f"reason:        {r['stop_reason']}: {r['summary']}", fg="red")
        elif result["mode"] == "crew" and result.get("tests_passed") is False:
            self._line("stopped:       the full suite still fails in the result (retry limit reached)", fg="red")
        elif result["mode"] == "crew" and result.get("verdict") and not result["verdict"]["approved"]:
            self._line("stopped:       the reviewer did not approve (retry limit reached)", fg="red")
        if result["mode"] == "crew":
            self._line(f"retries:       {result['retries']}/{self.max_retries}")
        self._line(f"files changed: {', '.join(result['files_changed']) or '(none)'}")
        branch = result.get("result_branch")
        if result["success"] and branch:
            self._line(f"result branch: {branch}")
            self._line("Inspect it:    git diff HEAD " + branch)
            self._line("Apply it:      git merge " + branch)
            return
        kept = result.get("kept_branches") or []
        if kept:
            base = (result.get("base_commit") or "HEAD")[:12]
            self._line(f"kept branches (with commits, base {base}):")
            for name in kept:
                self._line(f"  {name}")
                self._line(f"    git log --oneline {base}..{name}", dim=True)
                self._line(f"    git diff {base} {name}", dim=True)
            self._line("Delete them:   git branch -D " + " ".join(kept))


def _format_attempt(attempt: dict[str, Any]) -> str:
    """"gpt-oss-20b (attempt 1, failed)" or "retry 1: gpt-oss-120b (passed)"."""
    models = " then ".join(short_model(m) for m in attempt.get("models") or []) or "?"
    if attempt.get("retry"):
        return f"retry {attempt['retry']}: {models} ({attempt['outcome']})"
    return f"{models} (attempt {attempt['attempt']}, {attempt['outcome']})"


def _average(prompt_tokens: int, llm_calls: int | None) -> str:
    """Prompt tokens per LLM call; "-" for runs recorded before calls were counted."""
    if not llm_calls:
        return "-"
    return f"{round(prompt_tokens / llm_calls):,}"


def short_model(model: str) -> str:
    """"groq/openai/gpt-oss-120b" -> "gpt-oss-120b"."""
    return model.rsplit("/", 1)[-1]


def _throttle_inputs(p: dict[str, Any]) -> str:
    """", limit 8,000/min, proportional" (older events have neither)."""
    parts = []
    if p.get("limit_tokens"):
        parts.append(f"limit {p['limit_tokens']:,}/min")
    if p.get("mode"):
        parts.append(p["mode"])
    return "".join(f", {part}" for part in parts)


def format_args(arguments: dict[str, Any], limit: int = 40) -> str:
    parts = []
    for key, value in arguments.items():
        text = repr(value)
        if len(text) > limit:
            text = text[: limit - 6] + "..." + text[-3:]
        parts.append(f"{key}={text}")
    return ", ".join(parts)
