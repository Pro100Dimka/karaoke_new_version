from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ResourceBudget:
    max_background_jobs: int = 2
    queue_capacity: int = 16
    cpu_threads: int = 4
    min_free_ram_bytes: int = 512 * 1024 * 1024
    min_free_disk_bytes: int = 512 * 1024 * 1024
    max_vram_fraction: float = 0.80
    processing_disk_multiplier: int = 5

    def __post_init__(self) -> None:
        if (
            self.max_background_jobs < 1
            or self.queue_capacity < 1
            or self.cpu_threads < 1
            or self.processing_disk_multiplier < 1
        ):
            raise ValueError("Resource limits must be positive")
        if not 0 < self.max_vram_fraction <= 1:
            raise ValueError("max_vram_fraction must be in (0, 1]")
