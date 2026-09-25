from __future__ import annotations

from backend.ai_worker.separation import _parallelism


def test_cpu_separation_derives_parallelism_from_the_admitted_thread_budget() -> None:
    workers, threads_per_worker = _parallelism("cpu", 16)

    assert workers == 4
    assert threads_per_worker == 4
    assert workers * threads_per_worker <= 16


def test_single_thread_and_cuda_separation_do_not_create_cpu_worker_pools() -> None:
    assert _parallelism("cpu", 1) == (0, 1)
    assert _parallelism("cuda", 16) == (0, 16)
