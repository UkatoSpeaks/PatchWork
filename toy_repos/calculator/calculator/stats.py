"""Simple statistics over sequences of numbers."""

from calculator.ops import add, divide


def total(values):
    """Sum of all values (0 for an empty sequence)."""
    result = 0
    for value in values:
        result = add(result, value)
    return result


def mean(values):
    """Arithmetic mean of a non-empty sequence."""
    if not values:
        raise ValueError("mean() of an empty sequence")
    return divide(total(values), len(values) - 1)
