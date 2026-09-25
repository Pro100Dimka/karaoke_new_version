from __future__ import annotations

import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from backend.ai.domain import AiProviderDescriptor
from backend.ai.ports import AiProvider
from backend.diagnostics.ports import RuntimeProbe
from backend.domain_errors import DependencyError
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import (
    ComputeAvailability,
    ComputeRequirements,
    ComputeDevice,
    ExecutionContext,
    select_execution_context,
)
from backend.processing.policies import ResourceBudget
from backend.processing.preflight import ProcessingProviders
from backend.storage.ports import StorageSystem


@dataclass(frozen=True, slots=True)
class ResourceRequest:
    cpu_threads: int
    ram_bytes: int
    vram_bytes: int
    disk_bytes: int


class ResourceLease:
    def __init__(
        self,
        scheduler: "ProcessingResourceScheduler",
        request: ResourceRequest,
        execution: ExecutionContext,
    ) -> None:
        self._scheduler = scheduler
        self._request = request
        self.execution = execution
        self._released = False
        self._lock = threading.Lock()

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
        self._scheduler.release(self._request)


class ProcessingResourceScheduler:
    def __init__(
        self,
        runtime: RuntimeProbe,
        storage: StorageSystem,
        disk_root: Path,
        budget: ResourceBudget,
    ) -> None:
        self._runtime = runtime
        self._storage = storage
        self._disk_root = disk_root
        self._budget = budget
        self._lock = threading.Lock()
        self._reserved_cpu = 0
        self._reserved_ram = 0
        self._reserved_vram = 0

    def claim(
        self,
        providers: ProcessingProviders,
        source_bytes: int,
        compute_mode: ComputeMode = ComputeMode.AUTO,
        *,
        cpu_threads: int | None = None,
    ) -> ResourceLease:
        descriptors = (
            providers.separation.descriptor,
            providers.asr.descriptor,
            providers.alignment.descriptor,
            providers.pitch.descriptor,
        )
        return self._claim(descriptors, source_bytes, compute_mode, cpu_threads)

    def claim_provider(
        self,
        provider: AiProvider,
        source_bytes: int,
        compute_mode: ComputeMode = ComputeMode.AUTO,
        *,
        cpu_threads: int | None = None,
    ) -> ResourceLease:
        return self._claim((provider.descriptor,), source_bytes, compute_mode, cpu_threads)

    def _claim(
        self,
        descriptors: tuple[AiProviderDescriptor, ...],
        source_bytes: int,
        compute_mode: ComputeMode,
        cpu_threads: int | None,
    ) -> ResourceLease:
        threads = (
            self._budget.cpu_threads
            if cpu_threads is None
            else max(1, min(cpu_threads, self._budget.cpu_threads))
        )
        request = self._request(descriptors, source_bytes, threads)
        self._storage.require_free(
            self._disk_root,
            self._budget.min_free_disk_bytes + request.disk_bytes,
        )
        runtime = self._runtime.inspect()
        usable_vram = _usable_vram(
            runtime.free_vram_bytes, runtime.vram_bytes, self._budget.max_vram_fraction
        )
        execution = select_execution_context(
            compute_mode,
            _compute_requirements(descriptors, request.vram_bytes),
            ComputeAvailability(runtime.cuda_available, usable_vram),
            request.cpu_threads,
        )
        with self._lock:
            self._validate(request, runtime.available_ram_bytes, usable_vram, execution)
            self._reserved_cpu += request.cpu_threads
            self._reserved_ram += request.ram_bytes
            self._reserved_vram += request.vram_bytes
        return ResourceLease(self, request, execution)

    def release(self, request: ResourceRequest) -> None:
        with self._lock:
            self._reserved_cpu = max(0, self._reserved_cpu - request.cpu_threads)
            self._reserved_ram = max(0, self._reserved_ram - request.ram_bytes)
            self._reserved_vram = max(0, self._reserved_vram - request.vram_bytes)

    def _request(
        self,
        descriptors: tuple[AiProviderDescriptor, ...],
        source_bytes: int,
        cpu_threads: int,
    ) -> ResourceRequest:
        ram = max(
            (_resource(item.required_resources, "ramBytes") for item in descriptors), default=0
        )
        vram = max(
            (_resource(item.required_resources, "vramBytes") for item in descriptors), default=0
        )
        disk = max(0, source_bytes) * self._budget.processing_disk_multiplier
        return ResourceRequest(cpu_threads, ram, vram, disk)

    def _validate(
        self,
        request: ResourceRequest,
        available_ram: int | None,
        usable_vram: int | None,
        execution: ExecutionContext,
    ) -> None:
        if self._reserved_cpu + request.cpu_threads > self._budget.cpu_threads:
            raise DependencyError(
                "ResourceBudgetExceeded", "CPU processing budget is currently exhausted"
            )
        if available_ram is not None:
            required = self._reserved_ram + request.ram_bytes + self._budget.min_free_ram_bytes
            if required > available_ram:
                raise DependencyError(
                    "ResourceBudgetExceeded", "RAM processing budget is currently exhausted"
                )
        if execution.device is not ComputeDevice.CUDA or request.vram_bytes <= 0:
            return
        if usable_vram is not None and self._reserved_vram + request.vram_bytes > usable_vram:
            raise DependencyError(
                "ResourceBudgetExceeded", "VRAM processing budget is currently exhausted"
            )


def _compute_requirements(
    descriptors: tuple[AiProviderDescriptor, ...], vram_bytes: int
) -> ComputeRequirements:
    return ComputeRequirements(
        requires_cuda=vram_bytes > 0,
        supports_cuda=any(
            item.required_resources.get("supportsCuda") is True for item in descriptors
        ),
        vram_bytes=vram_bytes,
    )


def _resource(resources: Mapping[str, int | float | str], key: str) -> int:
    value = resources.get(key, 0)
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0
    return max(0, int(value))


def _usable_vram(free: int | None, total: int | None, fraction: float) -> int | None:
    if total is None and free is None:
        return None
    fraction_limit = int(total * fraction) if total is not None else free
    if free is None:
        return fraction_limit
    if fraction_limit is None:
        return free
    return min(free, fraction_limit)
