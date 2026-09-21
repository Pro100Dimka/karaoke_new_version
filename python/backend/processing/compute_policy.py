from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from backend.domain_errors import DependencyError
from backend.models.domain import ComputeMode


class ComputeDevice(StrEnum):
    CPU = "CPU"
    CUDA = "CUDA"


@dataclass(frozen=True, slots=True)
class ExecutionContext:
    """Immutable per-job execution plan; created before any stage runs and never changed by a stage."""

    device: ComputeDevice
    cpu_threads: int
    fallback_reason: str | None = None


@dataclass(frozen=True, slots=True)
class ComputeRequirements:
    requires_cuda: bool
    supports_cuda: bool
    vram_bytes: int


@dataclass(frozen=True, slots=True)
class ComputeAvailability:
    cuda_available: bool
    usable_vram_bytes: int | None


def select_execution_context(
    mode: ComputeMode,
    requirements: ComputeRequirements,
    availability: ComputeAvailability,
    cpu_threads: int,
) -> ExecutionContext:
    """Decides CPU or CUDA from capabilities only, never from a device model or vendor name."""
    if requirements.requires_cuda:
        return _cuda_required(mode, requirements, availability, cpu_threads)
    if mode is ComputeMode.CPU or not requirements.supports_cuda:
        if mode is ComputeMode.CUDA:
            raise DependencyError(
                "UnsupportedComputeMode", "Selected AI providers cannot run on CUDA"
            )
        return ExecutionContext(ComputeDevice.CPU, cpu_threads)
    reason = _cuda_blocker(requirements, availability)
    if reason is None:
        return ExecutionContext(ComputeDevice.CUDA, cpu_threads)
    if mode is ComputeMode.CUDA:
        raise _cuda_error(reason)
    # Auto falls back explicitly; the reason is reported with the processing result.
    return ExecutionContext(ComputeDevice.CPU, cpu_threads, fallback_reason=_fallback_text(reason))


def _cuda_required(
    mode: ComputeMode,
    requirements: ComputeRequirements,
    availability: ComputeAvailability,
    cpu_threads: int,
) -> ExecutionContext:
    if mode is ComputeMode.CPU:
        raise DependencyError(
            "UnsupportedComputeMode", "Selected AI providers require CUDA but CPU mode is selected"
        )
    reason = _cuda_blocker(requirements, availability)
    if reason is not None:
        raise _cuda_error(reason)
    return ExecutionContext(ComputeDevice.CUDA, cpu_threads)


def _cuda_blocker(
    requirements: ComputeRequirements, availability: ComputeAvailability
) -> str | None:
    if not availability.cuda_available:
        return "MissingCuda"
    usable = availability.usable_vram_bytes
    if usable is not None and requirements.vram_bytes > usable:
        return "InsufficientVram"
    return None


def _fallback_text(reason: str) -> str:
    if reason == "MissingCuda":
        return "CUDA is unavailable; processing runs on CPU"
    return "Not enough VRAM for CUDA; processing runs on CPU"


def _cuda_error(reason: str) -> DependencyError:
    if reason == "MissingCuda":
        return DependencyError(reason, "Selected AI providers require CUDA, which is unavailable")
    return DependencyError(
        reason, "Selected AI providers need more VRAM than the configured budget allows"
    )
