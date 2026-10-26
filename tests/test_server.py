"""The dashboard API, against the fixture run in tests/fixtures/runs."""

import asyncio
import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from patchwork.server import MAX_GAP_S, EventTail, create_app, follow

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "runs"
RUN_ID = "20261019-120000-f1x7"


@pytest.fixture
def runs(tmp_path: Path) -> Path:
    runs = tmp_path / "runs"
    shutil.copytree(FIXTURES, runs)
    # A run without events is skipped; a run still in progress has no result.json.
    (runs / "20261019-130000-empt").mkdir()
    (runs / "20261019-130000-empt" / "events.jsonl").write_text("")
    live = runs / "20261019-140000-live"
    live.mkdir()
    lines = (FIXTURES / RUN_ID / "events.jsonl").read_text(encoding="utf-8").splitlines()[:12]
    lines = [line.replace(RUN_ID, "20261019-140000-live").replace("2026-10-19T06:", "2026-10-19T08:") for line in lines]
    # A half-written last line is ignored.
    (live / "events.jsonl").write_text("\n".join(lines) + '\n{"run_id": "2026', encoding="utf-8")
    (runs / "usage.json").write_text("{}")
    return runs


@pytest.fixture
def client(runs: Path) -> TestClient:
    return TestClient(create_app(runs))


def fixture_events() -> list[dict]:
    return [json.loads(line) for line in (FIXTURES / RUN_ID / "events.jsonl").read_text(encoding="utf-8").splitlines()]


def parse_sse(text: str) -> list[tuple[str, dict]]:
    frames = []
    for block in text.strip().split("\n\n"):
        name, data = "message", None
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line.removeprefix("event: ")
            elif line.startswith("data: "):
                data = json.loads(line.removeprefix("data: "))
        frames.append((name, data))
    return frames


def test_list_runs_newest_first_skipping_empty(client: TestClient) -> None:
    response = client.get("/api/runs")
    assert response.status_code == 200
    runs = response.json()
    assert [r["run_id"] for r in runs] == ["20261019-140000-live", RUN_ID]
    live, done = runs
    assert done["mode"] == "crew" and done["sequential"] is False
    assert done["issue"] == "Add a median() function."
    assert done["repo"] == "C:/tmp/stats" and done["retries"] == 1
    assert live["retries"] is None
    assert done["success"] is True and done["finished"] is True
    assert done["total_tokens"] == 12990
    assert done["duration_s"] == 32.2
    assert done["started_at"] == "2026-10-19T06:30:00.000+00:00"
    # In progress: no result yet, tokens summed from agent_finished events.
    assert live["success"] is None and live["finished"] is False
    assert done["status"] == "finished"
    # No run lock names it, so it crashed or was killed.
    assert live["status"] == "stopped"
    assert live["total_tokens"] == 2540


def test_run_detail(client: TestClient) -> None:
    body = client.get(f"/api/runs/{RUN_ID}").json()
    assert body["result"]["run_id"] == RUN_ID
    assert body["result"]["retries"] == 1
    assert body["plan"]["subtasks"][1]["id"] == "c1"
    assert body["summary"]["total_tokens"] == 12990


def test_run_detail_without_result_takes_the_plan_from_the_lead(client: TestClient) -> None:
    body = client.get("/api/runs/20261019-140000-live").json()
    assert body["result"] is None
    assert body["plan"]["issue_summary"] == "Add median() to stats"


def test_events(client: TestClient) -> None:
    events = client.get(f"/api/runs/{RUN_ID}/events").json()
    assert events == fixture_events()


@pytest.mark.parametrize("path", ["/api/runs/nope", "/api/runs/nope/events", "/api/runs/20261019-130000-empt/events",
                                  "/api/runs/..%2F..%2Fetc/events"])
def test_unknown_runs_are_404(client: TestClient, path: str) -> None:
    assert client.get(path).status_code == 404


def test_stream_without_delays_replays_in_order_then_ends(client: TestClient) -> None:
    with client.stream("GET", f"/api/runs/{RUN_ID}/stream", params={"speed": 0}) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        frames = parse_sse(response.read().decode())
    *messages, end = frames
    assert [name for name, _ in messages] == ["message"] * len(messages)
    assert [data for _, data in messages] == fixture_events()
    assert [e["seq"] for _, e in messages] == list(range(1, len(messages) + 1))
    assert end == ("end", {"events": len(messages)})


def test_stream_from_start_index(client: TestClient) -> None:
    with client.stream("GET", f"/api/runs/{RUN_ID}/stream", params={"speed": 0, "start": 55}) as response:
        frames = parse_sse(response.read().decode())
    assert [data["seq"] for name, data in frames if name == "message"] == [56, 57, 58, 59, 60, 61]
    assert frames[-1][0] == "end"


def test_cors_allows_the_dev_frontend(client: TestClient) -> None:
    response = client.get("/api/runs", headers={"Origin": "http://localhost:3000"})
    assert response.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_replay_scales_gaps_and_caps_them(monkeypatch, tmp_path: Path) -> None:
    sleeps: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleeps.append(delay)

    monkeypatch.setattr("patchwork.server.asyncio.sleep", fake_sleep)
    events = [
        {"type": "note", "timestamp": "2026-10-19T06:30:00.000+00:00"},
        {"type": "note", "timestamp": "2026-10-19T06:30:04.000+00:00"},  # 4s / 4 = 1s
        {"type": "note", "timestamp": "2026-10-19T06:30:04.000+00:00"},  # no gap, no sleep
        {"type": "note", "timestamp": "2026-10-19T06:31:04.000+00:00"},  # 60s / 4 = 15s, capped
    ]
    path = tmp_path / "events.jsonl"
    path.write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")

    async def collect() -> list[str]:
        return [frame async for frame in follow(path, speed=4, start=0, alive=lambda: False)]

    frames = asyncio.run(collect())
    assert sleeps == [1.0, MAX_GAP_S]
    assert len(frames) == 5 and frames[-1].startswith("event: end")


def test_a_run_holding_the_lock_with_a_live_process_is_running(client: TestClient, runs: Path) -> None:
    (runs / ".patchwork.lock").write_text(json.dumps({"pid": os.getpid(), "run_id": "20261019-140000-live"}))
    assert client.get("/api/runs").json()[0]["status"] == "running"
    assert client.get("/api/runs/20261019-140000-live").json()["summary"]["status"] == "running"
    # A lock whose process is gone doesn't count.
    (runs / ".patchwork.lock").write_text(json.dumps({"pid": 999_999_999, "run_id": "20261019-140000-live"}))
    assert client.get("/api/runs").json()[0]["status"] == "stopped"


def test_event_tail_returns_only_new_complete_lines(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text('{"type": "a"}\n{"type": "b"', encoding="utf-8")
    tail = EventTail(path)
    assert [e["type"] for e in tail.read_new()] == ["a"]
    assert tail.read_new() == []
    with path.open("a", encoding="utf-8") as fh:
        fh.write('}\nnot json\n{"type": "c"}\n')
    assert [e["type"] for e in tail.read_new()] == ["b", "c"]


def _event(seq: int, type: str = "note") -> str:
    return json.dumps({"seq": seq, "type": type, "agent": "orchestrator", "timestamp": "2026-10-19T06:30:00+00:00"}) + "\n"


def test_follow_goes_live_then_sends_new_events_until_the_run_stops(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text(_event(1) + _event(2), encoding="utf-8")
    state = {"alive": True}

    async def run() -> list[tuple[str, dict]]:
        frames: list[str] = []
        stream = follow(path, speed=0, start=0, alive=lambda: state["alive"], poll_s=0.01)
        async for frame in stream:
            frames.append(frame)
            if frame.startswith("event: live"):
                with path.open("a", encoding="utf-8") as fh:
                    fh.write(_event(3))
            elif '"seq": 3' in frame:
                state["alive"] = False
        return parse_sse("".join(frames))

    frames = asyncio.run(run())
    assert [name for name, _ in frames] == ["message", "message", "live", "message", "end"]
    assert [data["seq"] for name, data in frames if name == "message"] == [1, 2, 3]
    assert frames[-1] == ("end", {"events": 3})


def test_follow_ends_at_run_finished_even_while_alive(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text(_event(1) + _event(2, "run_finished"), encoding="utf-8")

    async def run() -> list[tuple[str, dict]]:
        return parse_sse("".join([f async for f in follow(path, speed=0, start=0, alive=lambda: True, poll_s=0.01)]))

    assert [name for name, _ in asyncio.run(run())] == ["message", "message", "end"]
