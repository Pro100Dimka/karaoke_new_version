from __future__ import annotations

from pathlib import Path
from typing import Mapping

import pytest

from backend.diagnostics.ports import RuntimeDiagnostics
from backend.domain_errors import DependencyError
from backend.processing.policies import ResourceBudget
from backend.processing.preflight import ProcessingProviders
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from tests.fakes import FakeAiProvider


class FakeRuntimeProbe:
    def __init__(
        self,
        *,
        available_ram: int | None = 8_000,
        cuda: bool = False,
        total_vram: int | None = None,
        free_vram: int | None = None,
    ) -> None:
        self._value = RuntimeDiagnostics(
            python_version="3.12",
            cpu_count=8,
            total_ram_bytes=16_000,
            available_ram_bytes=available_ram,
            pytorch_version=None,
            cuda_available=cuda,
            cuda_runtime=None,
            gpu_name=None,
            vram_bytes=total_vram,
            free_vram_bytes=free_vram,
            ffmpeg_version="ffmpeg",
        )

    def inspect(self) -> RuntimeDiagnostics:
        return self._value


class FakeStorage:
    def __init__(self) -> None:
        self.requirements: list[int] = []

    def initialize(self) -> None:
        return None

    def free_bytes(self, path: Path) -> int:
        del path
        return 1_000_000

    def usage(self) -> Mapping[str, int]:
        return {}

    def require_free(self, path: Path, required_bytes: int) -> None:
        del path
        self.requirements.append(required_bytes)

    def cleanup_temp(self, max_age_seconds: int) -> int:
        del max_age_seconds
        return 0


def _providers(resources: Mapping[str, int | float | str]) -> ProcessingProviders:
    provider = FakeAiProvider(required_resources=resources)
    return ProcessingProviders(provider, provider, provider, provider)


@pytest.mark.parametrize(
    "ram,free_vram,total_vram,limited,threads,current,overlap",
    [
        (8000, 8000, 10000, True, 4, True, True),
        (1500, 8000, 10000, True, 4, True, False),
        (8000, 3000, 10000, True, 4, True, False),
        (8000, None, None, True, 4, False, False),
        (8000, 8000, 10000, False, 4, True, False),
        (8000, 8000, 10000, True, 1, True, False),
        (8000, 8000, 10000, True, 4, False, False),
    ],
)
def test_original_recognition_overlap_is_admitted_from_available_resources(
    tmp_path, ram, free_vram, total_vram, limited, threads, current, overlap
):
    from dataclasses import replace

    class StreamingProvider(FakeAiProvider):
        def transcribe_stream(self, *args, **options):
            raise AssertionError("Admission must not start recognition")

    provider = StreamingProvider(
        "local-torch", {"supportsCuda": True, "ramBytes": 1000, "vramBytes": 1000}
    )
    runtime = FakeRuntimeProbe(
        available_ram=ram, cuda=True, total_vram=total_vram, free_vram=free_vram
    )
    runtime._value = replace(
        runtime._value, cpu_limit_supported=limited, vram_is_current=current, gpu_name="Any GPU"
    )
    budget = ResourceBudget(cpu_threads=threads, min_free_ram_bytes=0, min_free_disk_bytes=0)
    scheduler = ProcessingResourceScheduler(runtime, FakeStorage(), tmp_path, budget)
    lease = scheduler.claim(ProcessingProviders(provider, provider, provider, provider), 10)
    assert lease.execution.parallel_cpu_fraction == (threads / 8 if overlap else None)
    assert scheduler._reserved_ram == (2000 if overlap else 1000)
    assert scheduler._reserved_vram == (2000 if overlap else 1000)
    lease.release()
    assert (scheduler._reserved_cpu, scheduler._reserved_ram, scheduler._reserved_vram) == (0, 0, 0)


def test_resource_scheduler_reserves_and_releases_cpu_budget(tmp_path: Path) -> None:
    budget = ResourceBudget(cpu_threads=4, min_free_ram_bytes=0, min_free_disk_bytes=0)
    scheduler = ProcessingResourceScheduler(FakeRuntimeProbe(), FakeStorage(), tmp_path, budget)
    providers = _providers({"cpuThreads": 1})
    lease = scheduler.claim(providers, source_bytes=100)

    with pytest.raises(DependencyError) as raised:
        scheduler.claim(providers, source_bytes=100)
    assert raised.value.code == "ResourceBudgetExceeded"

    lease.release()
    scheduler.claim(providers, source_bytes=100).release()


def test_resource_scheduler_enforces_ram_headroom(tmp_path: Path) -> None:
    budget = ResourceBudget(
        cpu_threads=4,
        min_free_ram_bytes=1_000,
        min_free_disk_bytes=0,
    )
    scheduler = ProcessingResourceScheduler(
        FakeRuntimeProbe(available_ram=1_500),
        FakeStorage(),
        tmp_path,
        budget,
    )

    with pytest.raises(DependencyError) as raised:
        scheduler.claim(_providers({"ramBytes": 600}), source_bytes=1)
    assert raised.value.code == "ResourceBudgetExceeded"


def test_resource_scheduler_rejects_vram_requirement_without_cuda(tmp_path: Path) -> None:
    budget = ResourceBudget(cpu_threads=4, min_free_ram_bytes=0, min_free_disk_bytes=0)
    scheduler = ProcessingResourceScheduler(
        FakeRuntimeProbe(cuda=False), FakeStorage(), tmp_path, budget
    )

    with pytest.raises(DependencyError) as raised:
        scheduler.claim(_providers({"vramBytes": 100}), source_bytes=1)
    assert raised.value.code == "MissingCuda"


def test_resource_scheduler_enforces_vram_fraction(tmp_path: Path) -> None:
    budget = ResourceBudget(
        cpu_threads=4,
        min_free_ram_bytes=0,
        min_free_disk_bytes=0,
        max_vram_fraction=0.5,
    )
    scheduler = ProcessingResourceScheduler(
        FakeRuntimeProbe(cuda=True, total_vram=1_000, free_vram=900),
        FakeStorage(),
        tmp_path,
        budget,
    )

    with pytest.raises(DependencyError) as raised:
        scheduler.claim(_providers({"vramBytes": 600}), source_bytes=1)
    assert raised.value.code == "InsufficientVram"


def test_resource_scheduler_includes_processing_disk_estimate(tmp_path: Path) -> None:
    storage = FakeStorage()
    budget = ResourceBudget(
        cpu_threads=4,
        min_free_ram_bytes=0,
        min_free_disk_bytes=1_000,
        processing_disk_multiplier=5,
    )
    scheduler = ProcessingResourceScheduler(FakeRuntimeProbe(), storage, tmp_path, budget)
    scheduler.claim(_providers({}), source_bytes=200).release()
    assert storage.requirements == [2_000]
