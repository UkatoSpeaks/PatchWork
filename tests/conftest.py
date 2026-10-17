import shutil
from pathlib import Path

import pytest

TOY_CALCULATOR = Path(__file__).resolve().parents[1] / "toy_repos" / "calculator"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """An empty repo root, with a sibling directory outside it."""
    root = tmp_path / "repo"
    root.mkdir()
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.txt").write_text("top secret\n")
    return root


TOY_STATS = Path(__file__).resolve().parents[1] / "toy_repos" / "stats_feature"


def copy_toy(source: Path, tmp_path: Path) -> Path:
    dest = tmp_path / source.name
    shutil.copytree(source, dest, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    return dest
