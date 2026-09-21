from __future__ import annotations

from scripts.architecture_check import check_project


def test_locked_architecture_gates() -> None:
    assert check_project() == []
