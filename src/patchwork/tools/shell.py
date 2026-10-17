"""Run a repository's test command in a subprocess with a timeout."""

from __future__ import annotations

import os
import shlex
import subprocess
import sys
import time
from collections.abc import Sequence
from pathlib import Path

from pydantic import BaseModel

MAX_OUTPUT_CHARS = 3_000


class RunTestsResult(BaseModel):
    command: list[str]
    exit_code: int | None
    timed_out: bool = False
    duration_seconds: float
    stdout: str
    stderr: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def summary_line(self) -> str:
        if self.timed_out:
            return f"TIMED OUT after {self.duration_seconds:.0f}s"
        status = "PASSED" if self.passed else f"FAILED (exit {self.exit_code})"
        last = next((ln.strip() for ln in reversed(self.stdout.splitlines()) if ln.strip()), "")
        return f"{status}: {last}" if last else status

    def render(self) -> str:
        """Compact text for the LLM."""
        parts = [self.summary_line()]
        if self.stdout.strip():
            parts.append("--- stdout (tail) ---\n" + self.stdout.rstrip())
        if self.stderr.strip():
            parts.append("--- stderr (tail) ---\n" + self.stderr.rstrip())
        return "\n".join(parts)


def truncate_tail(text: str, max_chars: int = MAX_OUTPUT_CHARS) -> str:
    """Keep the end of the output, where test failures and summaries are."""
    if len(text) <= max_chars:
        return text
    return f"[… {len(text) - max_chars} chars truncated …]\n" + text[-max_chars:]


def split_command(command: str | Sequence[str]) -> list[str]:
    if not isinstance(command, str):
        return list(command)
    if os.name == "nt":
        # posix=False keeps backslashes in Windows paths; strip the quotes it leaves.
        return [
            part[1:-1] if len(part) >= 2 and part[0] == part[-1] and part[0] in "\"'" else part
            for part in shlex.split(command, posix=False)
        ]
    return shlex.split(command)


def run_tests(
    root: str | os.PathLike[str],
    command: str | Sequence[str],
    timeout: float = 120.0,
    extra_args: Sequence[str] = (),
    max_output_chars: int = MAX_OUTPUT_CHARS,
) -> RunTestsResult:
    """Run ``command`` with ``root`` as the working directory.

    A leading ``python``/``python3`` is replaced by the current interpreter so
    the test runner from Patchwork's environment is used.
    """
    cwd = Path(root).resolve(strict=True)
    argv = split_command(command) + list(extra_args)
    if not argv:
        raise ValueError("empty test command")
    if argv[0] in ("python", "python3"):
        argv[0] = sys.executable
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"}

    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return RunTestsResult(
            command=argv,
            exit_code=None,
            timed_out=True,
            duration_seconds=time.monotonic() - started,
            stdout=truncate_tail(_as_text(exc.stdout), max_output_chars),
            stderr=truncate_tail(_as_text(exc.stderr), max_output_chars),
        )
    except FileNotFoundError:
        return RunTestsResult(
            command=argv,
            exit_code=127,
            duration_seconds=time.monotonic() - started,
            stdout="",
            stderr=f"command not found: {argv[0]}",
        )
    return RunTestsResult(
        command=argv,
        exit_code=proc.returncode,
        duration_seconds=time.monotonic() - started,
        stdout=truncate_tail(proc.stdout or "", max_output_chars),
        stderr=truncate_tail(proc.stderr or "", max_output_chars),
    )


def _as_text(data: str | bytes | None) -> str:
    if data is None:
        return ""
    if isinstance(data, bytes):
        return data.decode("utf-8", errors="replace")
    return data
