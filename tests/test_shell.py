import sys
from pathlib import Path

from patchwork.tools.shell import run_tests, truncate_tail


def test_truncate_tail_keeps_the_end():
    text = "".join(f"line {i}\n" for i in range(1000))
    out = truncate_tail(text, 100)
    assert out.endswith("line 999\n")
    assert out.startswith("[… ")
    assert "line 0\n" not in out


def test_run_tests_reports_exit_code_and_output(tmp_path: Path):
    result = run_tests(tmp_path, [sys.executable, "-c", "print('hello'); raise SystemExit(3)"])
    assert result.exit_code == 3
    assert not result.passed
    assert result.stdout.strip() == "hello"
    assert result.summary_line() == "FAILED (exit 3): hello"


def test_run_tests_python_alias_uses_current_interpreter(tmp_path: Path):
    result = run_tests(tmp_path, "python -c \"print('ok')\"")
    assert result.passed
    assert result.command[0] == sys.executable


def test_run_tests_timeout(tmp_path: Path):
    result = run_tests(tmp_path, [sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.5)
    assert result.timed_out
    assert result.exit_code is None
    assert not result.passed


def test_run_tests_truncates_long_output(tmp_path: Path):
    script = "for i in range(5000): print('row', i)"
    result = run_tests(tmp_path, [sys.executable, "-c", script], max_output_chars=200)
    assert len(result.stdout) < 300
    assert result.stdout.rstrip().endswith("row 4999")


def test_run_tests_missing_command(tmp_path: Path):
    result = run_tests(tmp_path, ["definitely-not-a-real-command-xyz"])
    assert result.exit_code == 127
