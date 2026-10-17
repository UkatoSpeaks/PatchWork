"""The toy repo must fail out of the box and pass once its planted bugs are fixed."""

import shutil
from pathlib import Path

from patchwork.tools import fs
from patchwork.tools.shell import run_tests

from conftest import TOY_CALCULATOR

COMMAND = "python -m pytest -q -p no:cacheprovider"


def _copy(tmp_path: Path) -> Path:
    dest = tmp_path / "calculator"
    shutil.copytree(TOY_CALCULATOR, dest, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    return dest


def test_toy_calculator_fails_with_planted_bugs(tmp_path: Path):
    result = run_tests(_copy(tmp_path), COMMAND)
    assert result.exit_code == 1
    assert "3 failed, 5 passed" in result.stdout


def test_toy_calculator_passes_once_fixed(tmp_path: Path):
    repo = _copy(tmp_path)
    fs.edit_file(repo, "calculator/ops.py", "return b - a", "return a - b")
    fs.edit_file(repo, "calculator/ops.py", "return a // b", "return a / b")
    fs.edit_file(repo, "calculator/stats.py", "len(values) - 1", "len(values)")
    result = run_tests(repo, COMMAND)
    assert result.passed, result.render()
