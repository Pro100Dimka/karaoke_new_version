from __future__ import annotations

import ctypes
import importlib
import os
import platform
import sys
from typing import Protocol, cast

from backend.cpu_info import logical_cpu_count
from backend.diagnostics.ports import RuntimeDiagnostics
from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessRunner


class _CudaProperties(Protocol):
    total_memory: int


class _CudaApi(Protocol):
    def is_available(self) -> bool: ...

    def get_device_name(self, index: int) -> str: ...

    def get_device_properties(self, index: int) -> _CudaProperties: ...

    def mem_get_info(self) -> tuple[int, int]: ...


class _TorchVersion(Protocol):
    cuda: str | None


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


class SystemRuntimeProbe:
    def __init__(self, processes: ProcessRunner) -> None:
        self._processes = processes

    def inspect(self) -> RuntimeDiagnostics:
        torch_data = _torch_data()
        total_ram, available_ram = _memory_bytes()
        return RuntimeDiagnostics(
            python_version=platform.python_version(),
            cpu_count=logical_cpu_count(),
            total_ram_bytes=total_ram,
            available_ram_bytes=available_ram,
            pytorch_version=torch_data[0],
            cuda_available=torch_data[1],
            cuda_runtime=torch_data[2],
            gpu_name=torch_data[3],
            vram_bytes=torch_data[4],
            free_vram_bytes=torch_data[5],
            ffmpeg_version=self._ffmpeg_version(),
        )

    def _ffmpeg_version(self) -> str | None:
        try:
            result = self._processes.run(["ffmpeg", "-version"], timeout_seconds=5)
        except DependencyError:
            return None
        if result.exit_code != 0:
            return None
        first = result.stdout.decode("utf-8", errors="replace").splitlines()
        return first[0] if first else None


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


def _torch_data() -> tuple[str | None, bool, str | None, str | None, int | None, int | None]:
    try:
        torch = importlib.import_module("torch")
    except ImportError:
        return None, False, None, None, None, None
    version = str(getattr(torch, "__version__", "unknown"))
    cuda = cast(_CudaApi | None, getattr(torch, "cuda", None))
    if cuda is None or not cuda.is_available():
        return version, False, None, None, None, None
    torch_version = cast(_TorchVersion | None, getattr(torch, "version", None))
    runtime = str(torch_version.cuda if torch_version and torch_version.cuda else "unknown")
    name = str(cuda.get_device_name(0))
    free_vram, total_vram = cuda.mem_get_info()
    return version, True, runtime, name, int(total_vram), int(free_vram)
