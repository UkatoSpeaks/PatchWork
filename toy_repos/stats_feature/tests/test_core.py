import pytest

from stats import data_range, mean, mode


def test_mean():
    assert mean([2, 4, 6]) == 4
    assert mean([1, 2]) == 1.5


def test_mode():
    assert mode([1, 2, 2, 3]) == 2
    assert mode([5, 7, 7, 5]) == 5


def test_data_range():
    assert data_range([3, 9, 1]) == 8
    assert data_range([4]) == 0


@pytest.mark.parametrize("func", [mean, mode, data_range])
def test_empty_raises(func):
    with pytest.raises(ValueError):
        func([])
