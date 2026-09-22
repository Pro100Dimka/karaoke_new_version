from __future__ import annotations

from dataclasses import dataclass, field

from backend.cpu_info import logical_cpu_count

# Below this many reserved cores, headroom stops scaling with machine size and just holds at this floor,
# so a small machine still keeps enough of itself free for the OS, the UI process and AudioService's
# real-time audio thread.
_MIN_RESERVED_CPU_THREADS = 2
_CPU_HEADROOM_FRACTION = 0.25


def cpu_threads_with_headroom(total_logical_cpus: int) -> int:
    """Never claims every logical core for AI inference (see docs/architecture_rules.md rule 19):
    a quarter of the machine, or two cores, whichever reserves more, is left for everything else."""
    reserved = max(_MIN_RESERVED_CPU_THREADS, round(total_logical_cpus * _CPU_HEADROOM_FRACTION))
    return max(_MIN_RESERVED_CPU_THREADS, total_logical_cpus - reserved)


def _default_cpu_threads() -> int:
    return cpu_threads_with_headroom(logical_cpu_count())


@dataclass(frozen=True, slots=True)
class ResourceBudget:
    max_background_jobs: int = 2
    queue_capacity: int = 16
    cpu_threads: int = field(default_factory=_default_cpu_threads)
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
