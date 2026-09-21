from __future__ import annotations

import pytest

from backend.domain_errors import DependencyError
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import (
    ComputeAvailability,
    ComputeDevice,
    ComputeRequirements,
    select_execution_context,
)

GIB = 1024**3
CUDA_OK = ComputeAvailability(cuda_available=True, usable_vram_bytes=8 * GIB)
NO_CUDA = ComputeAvailability(cuda_available=False, usable_vram_bytes=None)
CPU_ONLY = ComputeRequirements(requires_cuda=False, supports_cuda=False, vram_bytes=0)
CUDA_CAPABLE = ComputeRequirements(requires_cuda=False, supports_cuda=True, vram_bytes=2 * GIB)
CUDA_REQUIRED = ComputeRequirements(requires_cuda=True, supports_cuda=True, vram_bytes=2 * GIB)


def test_auto_uses_cuda_only_when_provider_supports_it_and_it_fits() -> None:
    context = select_execution_context(ComputeMode.AUTO, CUDA_CAPABLE, CUDA_OK, 4)

    assert context.device is ComputeDevice.CUDA
    assert context.fallback_reason is None


def test_auto_falls_back_to_cpu_with_an_observable_reason() -> None:
    missing = select_execution_context(ComputeMode.AUTO, CUDA_CAPABLE, NO_CUDA, 4)
    small = select_execution_context(
        ComputeMode.AUTO, CUDA_CAPABLE, ComputeAvailability(True, GIB), 4
    )

    assert missing.device is ComputeDevice.CPU and "unavailable" in (missing.fallback_reason or "")
    assert small.device is ComputeDevice.CPU and "VRAM" in (small.fallback_reason or "")


def test_auto_with_cpu_only_provider_is_plain_cpu_without_fallback_note() -> None:
    context = select_execution_context(ComputeMode.AUTO, CPU_ONLY, CUDA_OK, 4)

    assert context.device is ComputeDevice.CPU and context.fallback_reason is None


@pytest.mark.parametrize(
    ("mode", "requirements", "availability", "code"),
    [
        (ComputeMode.CUDA, CUDA_CAPABLE, NO_CUDA, "MissingCuda"),
        (ComputeMode.CUDA, CUDA_CAPABLE, ComputeAvailability(True, GIB), "InsufficientVram"),
        (ComputeMode.CUDA, CPU_ONLY, CUDA_OK, "UnsupportedComputeMode"),
        (ComputeMode.CPU, CUDA_REQUIRED, CUDA_OK, "UnsupportedComputeMode"),
        (ComputeMode.AUTO, CUDA_REQUIRED, NO_CUDA, "MissingCuda"),
        (ComputeMode.AUTO, CUDA_REQUIRED, ComputeAvailability(True, GIB), "InsufficientVram"),
    ],
)
def test_explicit_or_required_cuda_fails_with_a_specific_error(
    mode: ComputeMode,
    requirements: ComputeRequirements,
    availability: ComputeAvailability,
    code: str,
) -> None:
    with pytest.raises(DependencyError) as raised:
        select_execution_context(mode, requirements, availability, 4)

    assert raised.value.code == code
