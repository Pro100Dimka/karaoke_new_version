from __future__ import annotations

from dataclasses import dataclass

from backend.models.domain import ComputeMode


@dataclass(frozen=True, slots=True)
class BackendSettings:
    settings_schema_version: int
    compute_mode: ComputeMode = ComputeMode.AUTO
    cpu_threads: int = 4
    selected_separation_provider: str | None = None
    selected_asr_provider: str | None = None
    selected_pitch_provider: str | None = None
    selected_alignment_provider: str | None = None

    def __post_init__(self) -> None:
        if self.cpu_threads < 1:
            raise ValueError("cpu_threads must be positive")
