from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class RuntimeDiagnostics:
    python_version: str
    cpu_count: int
    total_ram_bytes: int | None
    available_ram_bytes: int | None
    pytorch_version: str | None
    cuda_available: bool
    cuda_runtime: str | None
    gpu_name: str | None
    vram_bytes: int | None
    free_vram_bytes: int | None
    ffmpeg_version: str | None


class RuntimeProbe(Protocol):
    def inspect(self) -> RuntimeDiagnostics: ...
