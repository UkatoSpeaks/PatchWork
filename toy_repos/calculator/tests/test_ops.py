import pytest

from calculator import add, divide, multiply, subtract


def test_add():
    assert add(2, 3) == 5
    assert add(-1, 1) == 0


def test_subtract():
    assert subtract(5, 3) == 2
    assert subtract(0, 4) == -4


def test_multiply():
    assert multiply(4, 3) == 12
    assert multiply(-2, 3) == -6


def test_divide():
    assert divide(7, 2) == 3.5
    assert divide(9, 3) == 3


def test_divide_by_zero():
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)
