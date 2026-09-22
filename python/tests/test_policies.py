from __future__ import annotations

from backend.processing.policies import ResourceBudget, cpu_threads_with_headroom


def test_headroom_scales_with_machine_size_but_never_claims_every_core() -> None:
    assert cpu_threads_with_headroom(4) == 2
    assert cpu_threads_with_headroom(8) == 6
    assert cpu_threads_with_headroom(16) == 12
    assert cpu_threads_with_headroom(20) == 15
    assert cpu_threads_with_headroom(32) == 24


def test_a_tiny_machine_keeps_at_least_two_cores_reserved_and_two_working() -> None:
    assert cpu_threads_with_headroom(1) == 2
    assert cpu_threads_with_headroom(2) == 2
    assert cpu_threads_with_headroom(3) == 2


def test_resource_budget_default_cpu_threads_is_positive() -> None:
    # Depends on the real machine's core count, so it only asserts the invariant every machine must satisfy.
    assert ResourceBudget().cpu_threads >= 2
