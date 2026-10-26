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
  each gap capped at ``MAX_GAP_S``. For a run that is still going, once the
  replay has caught up it sends a ``live`` event and then each new event as
  it is written. A final ``end`` event closes the stream.

Starting runs (the "New run" page):

- ``GET /api/config``: the models from .env, defaults, whether the API key is
  set and which run (if any) is going.
- ``GET /api/toy-repos``: the toy repos with their ISSUE.md.
- ``GET /api/repo-check?path=...``: whether a folder can be used as-is.
- ``POST /api/runs`` (JSON ``LaunchRequest``): start a crew run in the
  background; returns ``{"run_id": ...}`` (201), 400 for a bad request and 409
  while another run is going.
- ``GET /api/launches/{run_id}``: a started run's process: ``starting``,
  ``running`` or ``exited`` (with the end of its console output).
- ``POST /api/runs/{run_id}/stop``: ask a running run to stop (202). It
  cancels the agent at work, cleans up and writes its result within a few
  seconds; until then its summary has ``stop_requested``. 409 if it isn't
  running.

These are only served to the dashboard's origins (and to clients that send no
Origin, like curl), and POST requires a JSON body, so other web pages can't
start runs.

Every summary has a ``status``: ``finished`` (it has a result or a
``run_finished`` event), ``running`` (the run lock in ``runs/`` names it and
its process is alive) or ``stopped`` (stopped on request, with a result, or
neither of the others: it crashed or was killed).
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import AsyncIterator, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from patchwork.launcher import LaunchError, Launcher, LaunchRequest
from patchwork.runlock import LOCK_NAME, pid_alive, read_lock, stop_requested

# Longest pause between two replayed events, after dividing by the speed, so
# long rate-limit waits don't stall the replay.
MAX_GAP_S = 2.0
CORS_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]
# How often a live stream checks the log for new events, and how long it may
# stay silent before sending a keep-alive comment.
POLL_S = 0.5
KEEPALIVE_S = 15.0

_RUN_ID = re.compile(r"^[\w.-]+$")


def _parse_line(line: str) -> dict[str, Any] | None:
    if not line.strip():
        return None
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return None
    return event if isinstance(event, dict) and "type" in event else None


class EventTail:
    """Reads an events.jsonl incrementally. ``read_new`` returns the events
    added since the last call; a half-written last line is left for later."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.offset = 0

    def read_new(self) -> list[dict[str, Any]]:
        try:
            with self.path.open("rb") as fh:
                fh.seek(self.offset)
                chunk = fh.read()
        except OSError:
            return []
        end = chunk.rfind(b"\n")
        if end < 0:
            return []
        self.offset += end + 1
        events = []
        for line in chunk[: end + 1].decode("utf-8", errors="replace").splitlines():
            event = _parse_line(line)
            if event is not None:
                events.append(event)
        return events


def read_event_dicts(path: Path) -> list[dict[str, Any]]:
    """The events in an events.jsonl as plain dicts. Lines that don't parse
    (e.g. a half-written last line of a live run) are skipped."""
    events: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                event = _parse_line(line)
                if event is not None:
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


def run_is_alive(runs: Path, run_id: str) -> bool:
    """Whether the run lock in ``runs`` is held by ``run_id`` and its process is alive."""
    holder = read_lock(runs / LOCK_NAME) or {}
    pid = holder.get("pid")
    return holder.get("run_id") == run_id and isinstance(pid, int) and pid_alive(pid)


def summarize(
    run_id: str,
    events: list[dict[str, Any]],
    result: dict[str, Any] | None,
    alive: bool = False,
    stop_requested: bool = False,
) -> dict[str, Any]:
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
    finished = result is not None or events[-1]["type"] == "run_finished"
    if result is None and finished:
        result = (events[-1].get("payload") or {}).get("result")
    stopped = bool((result or {}).get("stopped"))
    return {
        "run_id": run_id,
        "started_at": events[0].get("timestamp"),
        "mode": mode,
        "sequential": sequential,
        "issue": issue.strip().splitlines()[0] if issue.strip() else "",
        "repo": str(info.get("repo") or ""),
        "retries": int(result.get("retries") or 0) if result else None,
        "success": result.get("success") if result else None,
        "finished": finished,
        "status": "stopped" if stopped else "finished" if finished else "running" if alive else "stopped",
        "stop_requested": stop_requested and not finished,
        "total_tokens": total_tokens,
        "duration_s": round((last - first).total_seconds(), 3) if first and last else None,
        "events": len(events),
    }


async def follow(
    path: Path, speed: float, start: int, alive: Callable[[], bool], poll_s: float = POLL_S
) -> AsyncIterator[str]:
    """SSE frames for the events in ``path`` from index ``start`` on, paced by their
    timestamps / ``speed`` (each gap capped at ``MAX_GAP_S``). When it runs out of events and ``alive()`` is true, it sends one
    ``live`` event, then each new event as soon as it is written (no pacing),
    until ``run_finished`` or the run is no longer alive. Ends with ``end``."""
    tail = EventTail(path)
    events = tail.read_new()
    index = start
    previous: dict[str, Any] | None = events[start - 1] if 0 < start <= len(events) else None
    live = False
    quiet_s = 0.0
    while True:
        while index < len(events):
            event = events[index]
            if not live and speed > 0 and previous is not None:
                delay = min(_gap_s(previous, event) / speed, MAX_GAP_S)
                if delay > 0:
                    await asyncio.sleep(delay)
            previous = event
            yield f"id: {index}\ndata: {json.dumps(event)}\n\n"
            index += 1
            quiet_s = 0.0
            if event["type"] == "run_finished":
                yield f"event: end\ndata: {json.dumps({'events': index})}\n\n"
                return
        new = tail.read_new()
        if new:
            events.extend(new)
            continue
        if not alive():
            # One last read: the run may have written its final lines just now.
            events.extend(tail.read_new())
            if index < len(events):
                continue
            yield f"event: end\ndata: {json.dumps({'events': len(events)})}\n\n"
            return
        if not live:
            live = True
            yield f"event: live\ndata: {json.dumps({'events': len(events)})}\n\n"
        elif quiet_s >= KEEPALIVE_S:
            quiet_s = 0.0
            yield ": keep-alive\n\n"
        await asyncio.sleep(poll_s)
        quiet_s += poll_s


def dashboard_only(request: Request) -> None:
    """Refuse requests from other web pages: a browser always sends Origin on
    cross-site requests, and a JSON POST needs a CORS preflight we only grant
    to the dashboard."""
    origin = request.headers.get("origin")
    if origin is not None and origin not in CORS_ORIGINS:
        raise HTTPException(status_code=403, detail=f"origin {origin} may not start runs")
    if request.method == "POST" and not request.headers.get("content-type", "").startswith("application/json"):
        raise HTTPException(status_code=415, detail="send JSON")


def create_app(runs_dir: Path | str = "runs", launcher: Launcher | None = None) -> FastAPI:
    runs = Path(runs_dir)
    launcher = launcher or Launcher(runs)
    app = FastAPI(title="Patchwork", description="Run logs for the Patchwork dashboard, and starting runs.")
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET", "POST"], allow_headers=["*"])

    def run_dir(run_id: str) -> Path:
        directory = runs / run_id
        if not _RUN_ID.match(run_id) or not (directory / "events.jsonl").is_file():
            raise HTTPException(status_code=404, detail=f"no run {run_id!r}")
        return directory

    def summary_of(run_id: str, events: list[dict[str, Any]]) -> dict[str, Any]:
        return summarize(run_id, events, _read_json(runs / run_id / "result.json"),
                         run_is_alive(runs, run_id), stop_requested(runs, run_id))

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
                    summaries.append(summary_of(directory.name, events))
        summaries.sort(key=lambda s: (s["started_at"] or "", s["run_id"]), reverse=True)
        return summaries

    @app.get("/api/runs/{run_id}")
    def run_detail(run_id: str) -> dict[str, Any]:
        events = run_events(run_id)
        result = _read_json(run_dir(run_id) / "result.json")
        summary = summary_of(run_id, events)
        return {"summary": summary, "result": result, "plan": _plan(events, result)}

    @app.get("/api/runs/{run_id}/events")
    def events(run_id: str) -> list[dict[str, Any]]:
        return run_events(run_id)

    @app.get("/api/runs/{run_id}/stream")
    def stream(
        run_id: str,
        speed: float = Query(4.0, ge=0, description="Playback speed; 0 sends everything without delays."),
        start: int = Query(0, ge=0, description="Index of the first event to send."),
    ) -> StreamingResponse:
        run_events(run_id)  # 404 for an unknown or empty run
        path = run_dir(run_id) / "events.jsonl"
        return StreamingResponse(
            follow(path, speed, start, lambda: run_is_alive(runs, run_id)),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/config", dependencies=[Depends(dashboard_only)])
    def config() -> dict[str, Any]:
        return launcher.config()

    @app.get("/api/toy-repos", dependencies=[Depends(dashboard_only)])
    def toy_repos() -> list[dict[str, Any]]:
        return launcher.toy_repos()

    @app.get("/api/repo-check", dependencies=[Depends(dashboard_only)])
    def repo_check(path: str = Query(..., min_length=1, max_length=4096)) -> dict[str, Any]:
        return launcher.check_repo(path)

    @app.post("/api/runs", status_code=201, dependencies=[Depends(dashboard_only)])
    def start_run(request: LaunchRequest) -> dict[str, str]:
        try:
            return {"run_id": launcher.start(request)}
        except LaunchError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from None

    @app.post("/api/runs/{run_id}/stop", status_code=202, dependencies=[Depends(dashboard_only)])
    def stop_run(run_id: str) -> dict[str, str]:
        if not _RUN_ID.match(run_id):
            raise HTTPException(status_code=404, detail=f"no run {run_id!r}")
        try:
            launcher.stop(run_id)
        except LaunchError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from None
        return {"run_id": run_id, "state": "stopping"}

    @app.get("/api/launches/{run_id}", dependencies=[Depends(dashboard_only)])
    def launch_status(run_id: str) -> dict[str, Any]:
        status = launcher.status(run_id)
        if status is None:
            raise HTTPException(status_code=404, detail=f"run {run_id!r} wasn't started from this server")
        return status

    return app
