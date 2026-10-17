import os
from pathlib import Path

import pytest

from patchwork.tools import fs
from patchwork.tools.fs import PathOutsideRootError


def _symlink(link: Path, target: Path, is_dir: bool = False) -> None:
    try:
        os.symlink(target, link, target_is_directory=is_dir)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks are not permitted here (on Windows, enable Developer Mode)")


# --- path-safety guard -------------------------------------------------------

@pytest.mark.parametrize(
    "bad_path",
    ["../outside/secret.txt", "..", "sub/../../outside/secret.txt", "./../repo/../outside"],
)
def test_rejects_parent_traversal(repo: Path, bad_path: str):
    with pytest.raises(PathOutsideRootError):
        fs.resolve_in_root(repo, bad_path)


def test_rejects_absolute_path_outside_root(repo: Path):
    with pytest.raises(PathOutsideRootError):
        fs.resolve_in_root(repo, str(repo.parent / "outside" / "secret.txt"))


def test_allows_paths_inside_root(repo: Path):
    (repo / "a.txt").write_text("hi")
    assert fs.resolve_in_root(repo, "a.txt") == (repo / "a.txt").resolve()
    assert fs.resolve_in_root(repo, "sub/../a.txt") == (repo / "a.txt").resolve()
    assert fs.resolve_in_root(repo, str(repo / "a.txt")) == (repo / "a.txt").resolve()
    assert fs.resolve_in_root(repo, ".") == repo.resolve()


def test_rejects_prefix_sibling(tmp_path: Path):
    # "/x/repo-evil" must not count as inside "/x/repo".
    root = tmp_path / "repo"
    root.mkdir()
    (tmp_path / "repo-evil").mkdir()
    with pytest.raises(PathOutsideRootError):
        fs.resolve_in_root(root, "../repo-evil")


def test_rejects_symlinked_file_pointing_outside(repo: Path):
    _symlink(repo / "link.txt", repo.parent / "outside" / "secret.txt")
    with pytest.raises(PathOutsideRootError):
        fs.read_file(repo, "link.txt")
    with pytest.raises(PathOutsideRootError):
        fs.write_file(repo, "link.txt", "overwritten")
    assert (repo.parent / "outside" / "secret.txt").read_text() == "top secret\n"


def test_rejects_write_through_symlinked_dir(repo: Path):
    _symlink(repo / "linkdir", repo.parent / "outside", is_dir=True)
    with pytest.raises(PathOutsideRootError):
        fs.write_file(repo, "linkdir/new.txt", "x")
    with pytest.raises(PathOutsideRootError):
        fs.list_dir(repo, "linkdir")
    assert not (repo.parent / "outside" / "new.txt").exists()


def test_search_skips_symlinks_pointing_outside(repo: Path):
    (repo / "inside.txt").write_text("secret inside\n")
    _symlink(repo / "link.txt", repo.parent / "outside" / "secret.txt")
    matches = fs.search_code(repo, "secret")
    assert [m.path for m in matches] == ["inside.txt"]


@pytest.mark.parametrize(
    "call",
    [
        lambda r: fs.read_file(r, "../outside/secret.txt"),
        lambda r: fs.write_file(r, "../outside/pwned.txt", "x"),
        lambda r: fs.edit_file(r, "../outside/secret.txt", "top", "bottom"),
        lambda r: fs.list_dir(r, "../outside"),
        lambda r: fs.search_code(r, "secret", path="../outside"),
    ],
    ids=["read_file", "write_file", "edit_file", "list_dir", "search_code"],
)
def test_every_tool_enforces_the_guard(repo: Path, call):
    with pytest.raises(PathOutsideRootError):
        call(repo)
    assert not (repo.parent / "outside" / "pwned.txt").exists()
    assert (repo.parent / "outside" / "secret.txt").read_text() == "top secret\n"


# --- read_file 200-line limit and paging --------------------------------------

def _write_lines(path: Path, count: int) -> None:
    path.write_text("".join(f"line {i}\n" for i in range(1, count + 1)))


def test_read_file_returns_at_most_200_lines(repo: Path):
    _write_lines(repo / "big.txt", 500)
    out = fs.read_file(repo, "big.txt")
    body, footer = out.rsplit("\n", 1)
    assert len(body.splitlines()) == 200
    assert body.splitlines()[0] == "  1| line 1"
    assert body.splitlines()[-1] == "200| line 200"
    assert footer == "[big.txt: lines 1-200 of 500; use offset=201 for more]"


def test_read_file_limit_cannot_exceed_200(repo: Path):
    _write_lines(repo / "big.txt", 500)
    out = fs.read_file(repo, "big.txt", limit=1000)
    assert len(out.splitlines()) == 201  # 200 lines + footer


def test_read_file_pages_with_offset(repo: Path):
    _write_lines(repo / "big.txt", 450)
    second = fs.read_file(repo, "big.txt", offset=201).splitlines()
    assert second[0] == "201| line 201"
    assert second[-1] == "[big.txt: lines 201-400 of 450; use offset=401 for more]"
    last = fs.read_file(repo, "big.txt", offset=401).splitlines()
    assert last[0] == "401| line 401"
    assert len(last) == 51
    assert last[-1] == "[big.txt: lines 401-450 of 450]"


def test_read_file_small_file_has_no_more_hint(repo: Path):
    _write_lines(repo / "small.txt", 3)
    assert fs.read_file(repo, "small.txt").splitlines() == [
        "1| line 1", "2| line 2", "3| line 3", "[small.txt: lines 1-3 of 3]",
    ]


def test_read_file_offset_past_end(repo: Path):
    _write_lines(repo / "small.txt", 3)
    with pytest.raises(ValueError, match="past the end"):
        fs.read_file(repo, "small.txt", offset=10)


def test_read_file_caps_total_characters(repo: Path):
    (repo / "wide.txt").write_text(("x" * 300 + "\n") * 200)
    out = fs.read_file(repo, "wide.txt")
    assert len(out) <= fs.MAX_READ_CHARS + 100
    assert "use offset=" in out.splitlines()[-1]


# --- other fs tools -----------------------------------------------------------

def test_write_and_edit_file(repo: Path):
    fs.write_file(repo, "pkg/mod.py", "def f():\n    return 1\n")
    assert fs.edit_file(repo, "pkg/mod.py", "return 1", "return 2") == "edited pkg/mod.py at line 2"
    assert (repo / "pkg" / "mod.py").read_text() == "def f():\n    return 2\n"


def test_edit_file_requires_unique_match(repo: Path):
    (repo / "m.py").write_text("x = 1\nx = 1\n")
    with pytest.raises(ValueError, match="2 times"):
        fs.edit_file(repo, "m.py", "x = 1", "x = 2")
    with pytest.raises(ValueError, match="not found"):
        fs.edit_file(repo, "m.py", "y = 1", "y = 2")


def test_edit_file_preserves_crlf(repo: Path):
    (repo / "w.py").write_bytes(b"a = 1\r\nb = 2\r\n")
    fs.edit_file(repo, "w.py", "a = 1\nb = 2", "a = 1\nb = 3")
    assert (repo / "w.py").read_bytes() == b"a = 1\r\nb = 3\r\n"


def test_list_dir_marks_dirs_and_skips_noise(repo: Path):
    (repo / "src").mkdir()
    (repo / ".git").mkdir()
    (repo / "__pycache__").mkdir()
    (repo / "b.py").write_text("")
    assert fs.list_dir(repo).splitlines() == ["src/", "b.py"]


def test_search_code_returns_path_line_and_text(repo: Path):
    (repo / "pkg").mkdir()
    (repo / "pkg" / "a.py").write_text("import os\n\ndef divide(a, b):\n    return a // b\n")
    (repo / "notes.md").write_text("divide things\n")
    matches = fs.search_code(repo, r"def divide")
    assert [(m.path, m.line, m.text) for m in matches] == [("pkg/a.py", 3, "def divide(a, b):")]
    assert [m.path for m in fs.search_code(repo, "divide")] == ["notes.md", "pkg/a.py"]
    assert [m.path for m in fs.search_code(repo, "divide", glob="*.py")] == ["pkg/a.py"]


def test_search_code_invalid_regex_falls_back_to_literal(repo: Path):
    (repo / "a.py").write_text("x = f(1\n")
    assert [m.line for m in fs.search_code(repo, "f(1")] == [1]
