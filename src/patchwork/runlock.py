"""One Patchwork run at a time.

Groq's rate limits are per account and model, so concurrent runs only starve
each other. ``run_lock`` takes ``runs/.patchwork.lock`` (holding the PID and
run id) for the duration of a run. A lock whose PID is no longer running is
stale and is replaced.
"""

from __future__ import annotations

import json
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

LOCK_NAME = ".patchwork.lock"


class RunLocked(RuntimeError):
    def __init__(self, holder: dict[str, Any]) -> None:
        super().__init__(
            f"another Patchwork run is in progress (run {holder.get('run_id', '?')}, pid {holder.get('pid', '?')}); "
            "Groq rate limits are shared, run one at a time"
        )
        self.holder = holder


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        # os.kill(pid, 0) would terminate the process on Windows; ask the kernel instead.
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: it exists
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_lock(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _age_seconds(path: Path) -> float:
    try:
        return datetime.now().timestamp() - path.stat().st_mtime
    except OSError:
        return float("inf")


@contextmanager
def run_lock(runs_dir: str | os.PathLike[str], run_id: str) -> Iterator[Path]:
    """Hold the run lock; raises ``RunLocked`` if a live process holds it."""
    runs_dir = Path(runs_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)
    path = runs_dir / LOCK_NAME
    mine = {"pid": os.getpid(), "run_id": run_id, "started": datetime.now().isoformat(timespec="seconds")}
    for _ in range(3):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            holder = read_lock(path)
            if holder is None:
                continue  # released meanwhile
            pid = holder.get("pid")
            if isinstance(pid, int) and pid_alive(pid):
                raise RunLocked(holder) from None
            if not isinstance(pid, int) and _age_seconds(path) < 5:
                raise RunLocked(holder) from None  # probably being written right now
            # Stale (its process is gone) or unreadable: replace it.
            path.unlink(missing_ok=True)
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(mine, fh)
        break
    else:
        raise RunLocked(read_lock(path) or {})
    try:
        yield path
    finally:
        if read_lock(path) == mine:
            path.unlink(missing_ok=True)
