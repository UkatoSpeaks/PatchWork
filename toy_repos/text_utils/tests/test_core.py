import pytest

from text_utils import capitalize_words, truncate, word_count


def test_word_count():
    assert word_count("hello world") == 2
    assert word_count("  spaced   out\ttext\n") == 3
    assert word_count("") == 0


def test_truncate_leaves_short_text_alone():
    assert truncate("short", 10) == "short"
    assert truncate("exact", 5) == "exact"


def test_truncate_cuts_with_suffix():
    assert truncate("hello world", 8) == "hello..."
    assert truncate("hello world", 6, suffix="~") == "hello~"


def test_truncate_tiny_widths():
    assert truncate("hello", 2) == ".."
    assert truncate("hello", 0) == ""


def test_truncate_rejects_negative_width():
    with pytest.raises(ValueError):
        truncate("hello", -1)


def test_capitalize_words():
    assert capitalize_words("hello big world") == "Hello Big World"
    assert capitalize_words("  already Fine ") == "Already Fine"
