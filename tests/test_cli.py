"""CLI option handling (the crew itself is faked)."""

from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

import patchwork.cli as cli

MODELS = {"LEAD_MODEL": "lead", "TESTER_MODEL": "tester", "CODER_MODEL": "coder", "REVIEWER_MODEL": "reviewer"}


@pytest.fixture
def issues(tmp_path: Path, monkeypatch) -> list[str]:
    """Issues the (fake) orchestrator was run with."""
    received: list[str] = []

    class FakeOrchestrator:
        def __init__(self, **kwargs):
            pass

        async def run(self, issue):
            received.append(issue)
            return SimpleNamespace(success=True)

    monkeypatch.setattr(cli, "Orchestrator", FakeOrchestrator)
    monkeypatch.setattr(cli, "LLMClient", lambda **kw: object())
    monkeypatch.setattr(cli, "RUNS_DIR", tmp_path / "runs")
    return received


def squashed(output: str) -> str:
    """Output without whitespace or box drawing, so wrapping in Rich's error panel doesn't matter."""
    return "".join(c for c in output if not c.isspace() and not "─" <= c <= "╿")


def invoke(*args: str):
    return CliRunner().invoke(cli.app, ["run", *args], env=MODELS)


def test_issue_file_is_read_as_utf8(tmp_path: Path, issues):
    repo = tmp_path / "repo"
    repo.mkdir()
    issue = tmp_path / "ISSUE.md"
    issue.write_bytes("Add slugify(text): strip accents ('é' -> 'e').\n".encode("utf-8"))
    result = invoke("--repo", str(repo), "--issue-file", str(issue))
    assert result.exit_code == 0, result.output
    assert issues == ["Add slugify(text): strip accents ('é' -> 'e')."]


def test_issue_file_with_a_bom(tmp_path: Path, issues):
    repo = tmp_path / "repo"
    repo.mkdir()
    issue = tmp_path / "ISSUE.md"
    issue.write_bytes(b"\xef\xbb\xbf" + "Café -> cafe".encode("utf-8"))
    result = invoke("--repo", str(repo), "--issue-file", str(issue))
    assert result.exit_code == 0, result.output
    assert issues == ["Café -> cafe"]


def test_issue_and_issue_file_are_mutually_exclusive(tmp_path: Path, issues):
    repo = tmp_path / "repo"
    repo.mkdir()
    issue = tmp_path / "ISSUE.md"
    issue.write_text("from the file", encoding="utf-8")
    both = invoke("--repo", str(repo), "--issue", "inline", "--issue-file", str(issue))
    neither = invoke("--repo", str(repo))
    for result in (both, neither):
        assert result.exit_code == 2
        assert "exactlyoneof--issueand--issue-file" in squashed(result.output)
    assert issues == []


def test_issue_file_that_is_not_utf8_or_empty(tmp_path: Path, issues):
    repo = tmp_path / "repo"
    repo.mkdir()
    latin1 = tmp_path / "latin1.md"
    latin1.write_bytes("Café".encode("latin-1"))
    empty = tmp_path / "empty.md"
    empty.write_text("  \n", encoding="utf-8")
    assert invoke("--repo", str(repo), "--issue-file", str(latin1)).exit_code == 2
    assert invoke("--repo", str(repo), "--issue-file", str(empty)).exit_code == 2
    assert issues == []


def test_inline_issue_still_works(tmp_path: Path, issues):
    repo = tmp_path / "repo"
    repo.mkdir()
    assert invoke("--repo", str(repo), "--issue", "Fix it").exit_code == 0
    assert issues == ["Fix it"]
