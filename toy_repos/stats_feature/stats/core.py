"""Descriptive statistics over sequences of numbers."""

from collections import Counter


def mean(values):
    """Arithmetic mean. Raises ValueError on an empty sequence."""
    if not values:
        raise ValueError("mean() of an empty sequence")
    return sum(values) / len(values)


def mode(values):
    """Most common value; the first one seen wins a tie. Raises ValueError on an empty sequence."""
    if not values:
        raise ValueError("mode() of an empty sequence")
    counts = Counter(values)
    return max(counts, key=counts.__getitem__)


def data_range(values):
    """Largest value minus smallest value. Raises ValueError on an empty sequence."""
    if not values:
        raise ValueError("data_range() of an empty sequence")
    return max(values) - min(values)
