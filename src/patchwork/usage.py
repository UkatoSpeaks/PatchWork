"""Daily token usage per model, kept in ``runs/usage.json``.

Updated after every LLM call so the totals survive across runs. Days are the
local date. Per-day limits are remembered when the provider reveals them:
Groq sends the requests-per-day limit in its ``x-ratelimit-limit-requests``
header, and the tokens-per-day limit only in the text of a TPD 429 error.

Layout::

    {"days": {"2026-10-18": {"groq/openai/gpt-oss-120b":
        {"prompt_tokens": 0, "completion_tokens": 0, "requests": 0}}},
     "limits": {"groq/openai/gpt-oss-120b": {"tokens_per_day": 200000, "requests_per_day": 1000}}}
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


class UsageStore:
    def __init__(self, path: str | os.PathLike[str], today: Callable[[], date] = date.today) -> None:
        self.path = Path(path)
        self._today = today

    def record(self, model: str, prompt_tokens: int, completion_tokens: int) -> None:
        """Add one call's usage to today's totals."""
        data = self._load()
        entry = self._entry(data, model)
        entry["prompt_tokens"] += prompt_tokens
        entry["completion_tokens"] += completion_tokens
        entry["requests"] += 1
        self._save(data)

    def note_reported(self, model: str, used_tokens: int | None = None, tokens_per_day: int | None = None,
                      requests_per_day: int | None = None) -> None:
        """What the provider said about the daily limit (from headers or a 429 message).

        A reported "Used N" also counts usage outside Patchwork, so today's total
        is raised to it (never lowered)."""
        data = self._load()
        changed = False
        limits = data.setdefault("limits", {}).setdefault(model, {})
        for key, value in (("tokens_per_day", tokens_per_day), ("requests_per_day", requests_per_day)):
            if value is not None and limits.get(key) != value:
                limits[key] = value
                changed = True
        if used_tokens is not None:
            entry = self._entry(data, model)
            ours = entry["prompt_tokens"] + entry["completion_tokens"]
            if used_tokens > ours:
                entry["prompt_tokens"] += used_tokens - ours
                changed = True
        if changed:
            self._save(data)

    def day(self, day: str | None = None) -> dict[str, dict[str, Any]]:
        """Per model for ``day`` (default today): tokens, requests and the known daily limits."""
        data = self._load()
        day = day or self._today().isoformat()
        out: dict[str, dict[str, Any]] = {}
        for model, entry in sorted(data.get("days", {}).get(day, {}).items()):
            limits = data.get("limits", {}).get(model, {})
            out[model] = {
                "tokens": entry.get("prompt_tokens", 0) + entry.get("completion_tokens", 0),
                "requests": entry.get("requests", 0),
                "tokens_per_day": limits.get("tokens_per_day"),
                "requests_per_day": limits.get("requests_per_day"),
            }
        return out

    def days(self) -> list[str]:
        return sorted(self._load().get("days", {}))

    # --- file ---------------------------------------------------------------------

    def _entry(self, data: dict[str, Any], model: str) -> dict[str, int]:
        day = data.setdefault("days", {}).setdefault(self._today().isoformat(), {})
        entry = day.setdefault(model, {})
        for key in ("prompt_tokens", "completion_tokens", "requests"):
            entry.setdefault(key, 0)
        return entry

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as exc:
            log.warning("could not read %s (%s); starting a new usage file", self.path, exc)
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self, data: dict[str, Any]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_name(self.path.name + ".tmp")
            tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError as exc:
            # Usage tracking must never break a run.
            log.warning("could not update %s: %s", self.path, exc)


def format_day(usage: dict[str, dict[str, Any]], label: str = "today") -> list[str]:
    """One line per model, e.g. "groq/openai/gpt-oss-120b today: 152,400 / 200,000 tokens, 85 / 1,000 requests"."""
    lines = []
    for model, u in usage.items():
        tokens = f"{u['tokens']:,}" + (f" / {u['tokens_per_day']:,}" if u.get("tokens_per_day") else "")
        requests = f"{u['requests']:,}" + (f" / {u['requests_per_day']:,}" if u.get("requests_per_day") else "")
        lines.append(f"{model} {label}: {tokens} tokens, {requests} requests")
    return lines
