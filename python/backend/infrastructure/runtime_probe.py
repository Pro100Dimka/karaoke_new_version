from __future__ import annotations

import ctypes
import logging
import os
import platform
import sys
from dataclasses import dataclass
from functools import cached_property

from backend.cpu_info import logical_cpu_count
from backend.diagnostics.ports import RuntimeDiagnostics
from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessRunner
from backend.serialization import loads_optional_object

logger = logging.getLogger(__name__)

_MIB = 1024 * 1024

# Runs in a short-lived interpreter: importing torch in the backend itself would keep the whole
# CUDA stack (cuBLAS, cuDNN, NVRTC — about 0.7 GB of RAM) loaded for the backend's lifetime.
_TORCH_PROBE = """
import json, torch
cuda = torch.cuda.is_available()
free, total = torch.cuda.mem_get_info() if cuda else (None, None)
print(json.dumps({
    "version": str(torch.__version__),
    "cuda": cuda,
    "runtime": str(torch.version.cuda or "unknown") if cuda else None,
    "gpu": torch.cuda.get_device_name(0) if cuda else None,
    "total": total,
    "free": free,
}))
"""


@dataclass(frozen=True)
class _TorchFacts:
    version: str
    cuda: bool
    runtime: str | None
    gpu: str | None
    total_vram: int | None
    free_vram: int | None


class _MemoryStatus(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ulong),
        ("memory_load", ctypes.c_ulong),
        ("total_physical", ctypes.c_ulonglong),
        ("available_physical", ctypes.c_ulonglong),
        ("total_page_file", ctypes.c_ulonglong),
        ("available_page_file", ctypes.c_ulonglong),
        ("total_virtual", ctypes.c_ulonglong),
        ("available_virtual", ctypes.c_ulonglong),
        ("available_extended_virtual", ctypes.c_ulonglong),
    ]


# The PyTorch facts are the same for every probe in this process, so a successful probe is kept for
# the process lifetime; a failed one (driver not ready, broken install) is tried again next time.
_torch_cache: _TorchFacts | None = None


class SystemRuntimeProbe:
    def __init__(self, processes: ProcessRunner) -> None:
        self._processes = processes

    def inspect(self) -> RuntimeDiagnostics:
        global _torch_cache
        _torch_cache = _torch_cache or _torch_facts(self._processes)
        torch = _torch_cache
        total_vram, free_vram = (None, None)
        if torch and torch.cuda:
            # Free VRAM changes between jobs, so it is read fresh, without a CUDA context here.
            total_vram, free_vram = _gpu_memory(self._processes, torch.gpu) or (torch.total_vram, torch.free_vram)
        total_ram, available_ram = _memory_bytes()
        return RuntimeDiagnostics(
            python_version=platform.python_version(),
            cpu_count=logical_cpu_count(),
            total_ram_bytes=total_ram,
            available_ram_bytes=available_ram,
            pytorch_version=torch.version if torch else None,
            cuda_available=bool(torch and torch.cuda),
            cuda_runtime=torch.runtime if torch and torch.cuda else None,
            gpu_name=torch.gpu if torch and torch.cuda else None,
            vram_bytes=total_vram,
            free_vram_bytes=free_vram,
            ffmpeg_version=self._ffmpeg_version,
        )

    @cached_property
    def _ffmpeg_version(self) -> str | None:
        try:
            result = self._processes.run(["ffmpeg", "-version"], timeout_seconds=5)
        except DependencyError:
            return None
        if result.exit_code != 0:
            return None
        first = result.stdout.decode("utf-8", errors="replace").splitlines()
        return first[0] if first else None


def _torch_facts(processes: ProcessRunner) -> _TorchFacts | None:
    try:
        result = processes.run([sys.executable, "-c", _TORCH_PROBE], timeout_seconds=120)
    except DependencyError as exc:
        logger.warning("PyTorch runtime probe could not start: %s", exc)
        return None
    lines = result.stdout.decode("utf-8", errors="replace").strip().splitlines()
    try:
        facts = loads_optional_object(lines[-1]) if result.exit_code == 0 and lines else None
    except ValueError:
        facts = None
    if facts is None:
        logger.warning("PyTorch runtime probe is unavailable: %s",
                       result.stderr.decode("utf-8", errors="replace").strip()[-500:])
        return None
    return _TorchFacts(
        version=str(facts.get("version") or "unknown"),
        cuda=facts.get("cuda") is True,
        runtime=_optional_text(facts.get("runtime")),
        gpu=_optional_text(facts.get("gpu")),
        total_vram=_optional_int(facts.get("total")),
        free_vram=_optional_int(facts.get("free")),
    )


def _gpu_memory(processes: ProcessRunner, gpu: str | None) -> tuple[int, int] | None:
    """Total and free VRAM of the GPU PyTorch uses, from the NVIDIA driver's own tool."""
    try:
        result = processes.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            timeout_seconds=5,
        )
    except DependencyError:
        return None
    if result.exit_code != 0:
        return None
    rows = []
    for line in result.stdout.decode("utf-8", errors="replace").splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
            rows.append((parts[0], int(parts[1]) * _MIB, int(parts[2]) * _MIB))
    # CUDA and the driver may number GPUs differently; the name identifies the one PyTorch reported.
    row = next((item for item in rows if item[0] == gpu), rows[0] if rows else None)
    return (row[1], row[2]) if row else None


def _optional_text(value: object) -> str | None:
    return str(value) if value is not None else None


def _optional_int(value: object) -> int | None:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _memory_bytes() -> tuple[int | None, int | None]:
    if sys.platform.startswith("linux"):
        try:
            page_size = int(os.sysconf("SC_PAGE_SIZE"))
            total = int(os.sysconf("SC_PHYS_PAGES")) * page_size
            available = int(os.sysconf("SC_AVPHYS_PAGES")) * page_size
            return total, available
        except (ValueError, OSError, AttributeError):
            return None, None
    if sys.platform == "win32":
        return _windows_memory_bytes()
    return None, None


def _windows_memory_bytes() -> tuple[int | None, int | None]:
    status = _MemoryStatus()
    status.length = ctypes.sizeof(_MemoryStatus)
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        success = kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    except (AttributeError, OSError):
        return None, None
    if not success:
        return None, None
    return int(status.total_physical), int(status.available_physical)
