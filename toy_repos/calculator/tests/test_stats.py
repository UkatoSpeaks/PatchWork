import pytest

from calculator import mean, total


def test_total():
    assert total([1, 2, 3, 4]) == 10
    assert total([]) == 0


def test_mean():
    assert mean([2, 4, 6]) == 4
    assert mean([1, 2]) == 1.5


def test_mean_empty():
    with pytest.raises(ValueError):
        mean([])
