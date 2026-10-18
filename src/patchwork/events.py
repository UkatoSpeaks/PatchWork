"""Structured run events.

Agents and the orchestrator publish ``Event`` objects to an ``EventBus``.
Subscribers render them (the CLI), persist them (``JsonlWriter``) or stream
them (``EventBus.stream``, e.g. for a web frontend). Nothing else prints.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import AsyncIterator, Callable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

EventType = Literal[
    "run_started",
    "phase_started",
    "phase_finished",
    "agent_started",
    "llm_call",
    "tool_called",
    "tool_result",
    "rate_limited",
    "note",
    "agent_finished",
    "tests_run",
    "merge",
    "retry_started",
    "review_verdict",
    "run_finished",
]
AgentName = Literal["lead", "tester", "coder", "reviewer", "orchestrator"]

Subscriber = Callable[["Event"], None]


class Event(BaseModel):
    run_id: str
    seq: int
    timestamp: str
    agent: AgentName
    type: EventType
    payload: dict[str, Any] = Field(default_factory=dict)


def new_run_id() -> str:
    """Short, sortable and unique: 20261018-142233-a1f3."""
    return f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"


class EventBus:
    """Fans events out to subscribers in publish order.

    ``publish`` is synchronous so events from one agent keep their order and
    can be published from any point in the event loop. Async consumers use
    ``stream()``.
    """

    def __init__(self, run_id: str | None = None) -> None:
        self.run_id = run_id or new_run_id()
        self._seq = 0
        self._subscribers: list[Subscriber] = []
        self._queues: list[asyncio.Queue[Event | None]] = []

    def subscribe(self, subscriber: Subscriber) -> None:
        self._subscribers.append(subscriber)

    def publish(self, agent: AgentName, type: EventType, **payload: Any) -> Event:
        self._seq += 1
        event = Event(
            run_id=self.run_id,
            seq=self._seq,
            timestamp=datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            agent=agent,
            type=type,
            payload=payload,
        )
        for subscriber in self._subscribers:
            subscriber(event)
        for queue in self._queues:
            queue.put_nowait(event)
            if type == "run_finished":
                queue.put_nowait(None)
        return event

    async def stream(self) -> AsyncIterator[Event]:
        """Events published from now on, until run_finished."""
        queue: asyncio.Queue[Event | None] = asyncio.Queue()
        self._queues.append(queue)
        try:
            while (event := await queue.get()) is not None:
                yield event
        finally:
            self._queues.remove(queue)


class JsonlWriter:
    """Writes runs/<run_id>/events.jsonl as events arrive, and result.json
    (the RunResult from the run_finished event) at the end."""

    def __init__(self, directory: Path) -> None:
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.events_path = self.directory / "events.jsonl"
        self.result_path = self.directory / "result.json"

    def __call__(self, event: Event) -> None:
        with self.events_path.open("a", encoding="utf-8") as fh:
            fh.write(event.model_dump_json() + "\n")
        if event.type == "run_finished" and "result" in event.payload:
            self.result_path.write_text(json.dumps(event.payload["result"], indent=2), encoding="utf-8")


def read_events(path: Path) -> Iterator[Event]:
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                yield Event.model_validate_json(line)
