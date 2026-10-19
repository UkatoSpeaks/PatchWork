"""The toy repo must fail out of the box and pass once its planted bugs are fixed."""

import shutil
from pathlib import Path

from patchwork.tools import fs
from patchwork.tools.shell import run_tests

from conftest import TOY_CALCULATOR, TOY_STATS, TOY_TEXT_UTILS, copy_toy

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


def test_toy_stats_passes_and_has_no_median(tmp_path: Path):
    repo = copy_toy(TOY_STATS, tmp_path)
    result = run_tests(repo, COMMAND)
    assert result.passed, result.render()
    assert "6 passed" in result.stdout
    assert not fs.search_code(repo, r"def median")


def test_toy_text_utils_passes_and_has_no_slugify(tmp_path: Path):
    repo = copy_toy(TOY_TEXT_UTILS, tmp_path)
    result = run_tests(repo, COMMAND)
    assert result.passed, result.render()
    assert "6 passed" in result.stdout
    # Neither the package nor its suite knows slugify; only the issue asks for it.
    assert not fs.search_code(repo, r"slugify", path="text_utils")
    assert not fs.search_code(repo, r"slugify", path="tests")
    assert "slugify(text)" in (repo / "ISSUE.md").read_text(encoding="utf-8")
