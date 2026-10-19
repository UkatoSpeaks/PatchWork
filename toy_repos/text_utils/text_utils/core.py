"""Small text helpers."""


def word_count(text: str) -> int:
    """Number of whitespace-separated words in ``text``."""
    return len(text.split())


def truncate(text: str, width: int, suffix: str = "...") -> str:
    """``text`` cut to at most ``width`` characters, ending in ``suffix`` when cut."""
    if width < 0:
        raise ValueError("width must not be negative")
    if len(text) <= width:
        return text
    if width <= len(suffix):
        return suffix[:width]
    return text[: width - len(suffix)] + suffix


def capitalize_words(text: str) -> str:
    """Each whitespace-separated word with its first letter upper-cased."""
    return " ".join(word[:1].upper() + word[1:] for word in text.split())
