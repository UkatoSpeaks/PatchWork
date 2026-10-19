"""Read-only HTTP API over the run logs in ``runs/``, for the web dashboard.

``patchwork serve --port 8000 --runs-dir runs`` starts it. Every run is a
directory ``runs/<run_id>/`` with ``events.jsonl`` (one Event per line) and,
once finished, ``result.json`` (the RunResult).

- ``GET /api/runs``: one summary per run, newest first.
- ``GET /api/runs/{run_id}``: the summary, the RunResult (null while the run
  has none) and the plan.
- ``GET /api/runs/{run_id}/events``: every event.
- ``GET /api/runs/{run_id}/stream?speed=4&start=0``: server-sent events that
  replay the log with its original timing divided by ``speed`` (0: no delays),
  each gap capped at ``MAX_GAP_S``, then a final ``end`` event.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# Longest pause between two replayed events, after dividing by the speed, so
# long rate-limit waits don't stall the replay.
MAX_GAP_S = 2.0
CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]

_RUN_ID = re.compile(r"^[\w.-]+$")


def read_event_dicts(path: Path) -> list[dict[str, Any]]:
    """The events in an events.jsonl as plain dicts. Lines that don't parse
    (e.g. a half-written last line of a live run) are skipped."""
    events: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict) and "type" in event:
                    events.append(event)
    except OSError:
        return []
    return events


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _timestamp(event: dict[str, Any]) -> datetime | None:
    try:
        return datetime.fromisoformat(event["timestamp"])
    except (KeyError, TypeError, ValueError):
        return None


def _gap_s(previous: dict[str, Any], event: dict[str, Any]) -> float:
    a, b = _timestamp(previous), _timestamp(event)
    if a is None or b is None:
        return 0.0
    return max(0.0, (b - a).total_seconds())


def _plan(events: list[dict[str, Any]], result: dict[str, Any] | None) -> dict[str, Any] | None:
    """The plan from result.json, else from the lead's last successful finish."""
    if result and isinstance(result.get("plan"), dict):
        return result["plan"]
    for event in reversed(events):
        payload = event.get("payload") or {}
        if event.get("agent") == "lead" and event["type"] == "agent_finished" and isinstance(payload.get("output"), dict):
            return payload["output"]
    return None


def summarize(run_id: str, events: list[dict[str, Any]], result: dict[str, Any] | None) -> dict[str, Any]:
    started = next((e for e in events if e["type"] == "run_started"), None)
    info = (started or {}).get("payload") or {}
    mode = result.get("mode") if result else info.get("mode", "crew")
    sequential = bool(result.get("sequential") if result else info.get("sequential", False))
    issue = (result or {}).get("issue") or info.get("issue") or ""
    if result and "total_tokens" in result:
        total_tokens = int(result["total_tokens"])
    else:
        total_tokens = sum(int((e.get("payload") or {}).get("tokens") or 0) for e in events if e["type"] == "agent_finished")
    first, last = _timestamp(events[0]), _timestamp(events[-1])
    return {
        "run_id": run_id,
        "started_at": events[0].get("timestamp"),
        "mode": mode,
        "sequential": sequential,
        "issue": issue.strip().splitlines()[0] if issue.strip() else "",
        "success": result.get("success") if result else None,
        "finished": result is not None or events[-1]["type"] == "run_finished",
        "total_tokens": total_tokens,
        "duration_s": round((last - first).total_seconds(), 3) if first and last else None,
        "events": len(events),
    }


async def replay(events: list[dict[str, Any]], speed: float, start: int = 0) -> AsyncIterator[str]:
    """SSE frames for ``events[start:]``, paced by their timestamps / speed."""
    previous: dict[str, Any] | None = events[start - 1] if 0 < start <= len(events) else None
    for index in range(start, len(events)):
        event = events[index]
        if speed > 0 and previous is not None:
            delay = min(_gap_s(previous, event) / speed, MAX_GAP_S)
            if delay > 0:
                await asyncio.sleep(delay)
        previous = event
        yield f"id: {index}\ndata: {json.dumps(event)}\n\n"
    yield f"event: end\ndata: {json.dumps({'events': len(events)})}\n\n"


def create_app(runs_dir: Path | str = "runs") -> FastAPI:
    runs = Path(runs_dir)
    app = FastAPI(title="Patchwork", description="Run logs for the Patchwork dashboard.")
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET"], allow_headers=["*"])

    def run_dir(run_id: str) -> Path:
        directory = runs / run_id
        if not _RUN_ID.match(run_id) or not (directory / "events.jsonl").is_file():
            raise HTTPException(status_code=404, detail=f"no run {run_id!r}")
        return directory

    def run_events(run_id: str) -> list[dict[str, Any]]:
        events = read_event_dicts(run_dir(run_id) / "events.jsonl")
        if not events:
            raise HTTPException(status_code=404, detail=f"run {run_id!r} has no events")
        return events

    @app.get("/api/runs")
    def list_runs() -> list[dict[str, Any]]:
        summaries = []
        if runs.is_dir():
            for directory in runs.iterdir():
                events = read_event_dicts(directory / "events.jsonl") if directory.is_dir() else []
                if events:
                    summaries.append(summarize(directory.name, events, _read_json(directory / "result.json")))
        summaries.sort(key=lambda s: (s["started_at"] or "", s["run_id"]), reverse=True)
        return summaries

    @app.get("/api/runs/{run_id}")
    def run_detail(run_id: str) -> dict[str, Any]:
        events = run_events(run_id)
        result = _read_json(run_dir(run_id) / "result.json")
        return {"summary": summarize(run_id, events, result), "result": result, "plan": _plan(events, result)}

    @app.get("/api/runs/{run_id}/events")
    def events(run_id: str) -> list[dict[str, Any]]:
        return run_events(run_id)

    @app.get("/api/runs/{run_id}/stream")
    def stream(
        run_id: str,
        speed: float = Query(4.0, ge=0, description="Playback speed; 0 sends everything without delays."),
        start: int = Query(0, ge=0, description="Index of the first event to send."),
    ) -> StreamingResponse:
        replayed = run_events(run_id)
        return StreamingResponse(
            replay(replayed, speed, start),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app
