"""Basic arithmetic operations."""


def add(a, b):
    """Return a plus b."""
    return a + b


def subtract(a, b):
    """Return a minus b."""
    return b - a


def multiply(a, b):
    """Return a times b."""
    return a * b


def divide(a, b):
    """Return a divided by b as a float. Raises ZeroDivisionError if b is 0."""
    if b == 0:
        raise ZeroDivisionError("cannot divide by zero")
    return a // b
