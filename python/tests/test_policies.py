from __future__ import annotations

from backend.processing.policies import ResourceBudget, cpu_threads_with_headroom


def test_headroom_scales_with_machine_size_but_never_claims_every_core() -> None:
    assert cpu_threads_with_headroom(4) == 2
    assert cpu_threads_with_headroom(8) == 6
    assert cpu_threads_with_headroom(16) == 12
    assert cpu_threads_with_headroom(20) == 15
    assert cpu_threads_with_headroom(32) == 24


def test_a_tiny_machine_never_claims_nonexistent_cores_and_keeps_headroom_when_possible() -> None:
    for total in (1, 2, 3):
        assert cpu_threads_with_headroom(total) == 1


def test_resource_budget_default_cpu_threads_is_positive() -> None:
    # Depends on the real machine's core count, so it only asserts the invariant every machine must satisfy.
    assert ResourceBudget().cpu_threads >= 1
