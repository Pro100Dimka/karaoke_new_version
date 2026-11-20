import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.domain_errors import DependencyError
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import ComputeDevice
from backend.processing.policies import ResourceBudget
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from tests.fakes import FakeAiProvider
from tests.test_resource_scheduler import FakeRuntimeProbe, FakeStorage


def _scheduler(tmp_path):
    return ProcessingResourceScheduler(
        FakeRuntimeProbe(
            total_ram=2048,
            available_ram=2048,
            cuda=True,
            total_vram=2048,
            free_vram=2048,
        ),
        FakeStorage(),
        tmp_path,
        ResourceBudget(
            cpu_threads=4,
            min_free_ram_bytes=0,
            min_free_disk_bytes=0,
            max_vram_fraction=1,
        ),
    )


def _provider(ram, vram):
    return FakeAiProvider(
        required_resources={"supportsCuda": True, "ramBytes": ram, "vramBytes": vram}
    )


def _reserved(scheduler):
    return scheduler._reserved_cpu, scheduler._reserved_ram, scheduler._reserved_vram


@pytest.mark.parametrize("ram,vram", [(1536, 0), (0, 1536), (1536, 1536)])
def test_retain_cpu_admits_another_memory_consumer_without_releasing_cpu(tmp_path, ram, vram):
    scheduler = _scheduler(tmp_path)
    provider = _provider(ram, vram)
    retained = scheduler.claim_provider(provider, 10, ComputeMode.CUDA, cpu_threads=2)
    unrelated = scheduler.claim_provider(_provider(256, 256), 10, ComputeMode.CUDA, cpu_threads=1)
    successor = None
    execution = retained.execution
    try:
        with pytest.raises(DependencyError):
            scheduler.claim_provider(provider, 10, ComputeMode.CUDA, cpu_threads=1)

        retained.retain_cpu()
        successor = scheduler.claim_provider(provider, 10, ComputeMode.CUDA, cpu_threads=1)
        assert successor.execution.device is ComputeDevice.CUDA
        assert retained.execution is execution and execution.cpu_threads == 2
        assert _reserved(scheduler) == (4, 256 + ram, 256 + vram)
        with pytest.raises(DependencyError) as rejected:
            scheduler.claim_cpu(10, cpu_threads=1)
        assert rejected.value.code == "ResourceBudgetExceeded"

        retained.retain_cpu()
        assert _reserved(scheduler) == (4, 256 + ram, 256 + vram)
        retained.release()
        retained.retain_cpu()
        retained.release()
        assert _reserved(scheduler) == (2, 256 + ram, 256 + vram)
    finally:
        retained.release()
        unrelated.release()
        if successor is not None:
            successor.release()
    assert _reserved(scheduler) == (0, 0, 0)


def test_retention_has_no_cpu_gap_and_concurrent_finalizers_preserve_other_leases(
    tmp_path, monkeypatch
):
    scheduler = _scheduler(tmp_path)
    retained = scheduler.claim_provider(_provider(1024, 1024), 10, ComputeMode.CUDA, cpu_threads=2)
    released_memory, continue_retention = threading.Event(), threading.Event()
    racing = threading.Barrier(9)
    release = scheduler.release
    first_release = True
    hook_lock = threading.Lock()
    unrelated = probe = None

    def pause_first_release(request):
        nonlocal first_release
        release(request)
        with hook_lock:
            pause = first_release
            first_release = False
        if pause:
            released_memory.set()
            assert continue_retention.wait(5)

    def concurrent(action):
        racing.wait(timeout=5)
        action()

    monkeypatch.setattr(scheduler, "release", pause_first_release)
    try:
        with ThreadPoolExecutor(max_workers=9) as pool:
            retaining = pool.submit(retained.retain_cpu)
            futures = []
            try:
                assert released_memory.wait(2), "The finished separation still reserves memory"
                unrelated = scheduler.claim_provider(
                    _provider(1536, 1536), 10, ComputeMode.CUDA, cpu_threads=1
                )
                with pytest.raises(DependencyError) as rejected:
                    probe = scheduler.claim_cpu(10, cpu_threads=3)
                assert rejected.value.code == "ResourceBudgetExceeded"
                for action in [retained.release, retained.retain_cpu] * 4:
                    futures.append(pool.submit(concurrent, action))
                racing.wait(timeout=5)
            finally:
                continue_retention.set()
                retaining.result(timeout=5)
                for future in futures:
                    future.result(timeout=5)
        assert _reserved(scheduler) == (1, 1536, 1536)
        retained.retain_cpu()
        retained.release()
        assert _reserved(scheduler) == (1, 1536, 1536)
    finally:
        continue_retention.set()
        retained.release()
        if unrelated is not None:
            unrelated.release()
        if probe is not None:
            probe.release()
    assert _reserved(scheduler) == (0, 0, 0)
