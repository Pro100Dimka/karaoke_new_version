from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

from backend.cpu_info import logical_cpu_count
from backend.models.domain import ComputeMode
from backend.processing.policies import cpu_threads_with_headroom


class ProcessingBackend(StrEnum):
    LOCAL = "Local"
    KAGGLE = "Kaggle"


@dataclass(frozen=True, slots=True)
class BackendSettings:
    settings_schema_version: int
    compute_mode: ComputeMode = ComputeMode.AUTO
    cpu_threads: int = field(
        default_factory=lambda: cpu_threads_with_headroom(logical_cpu_count())
    )
    selected_separation_provider: str | None = None
    selected_asr_provider: str | None = None
    selected_pitch_provider: str | None = None
    selected_alignment_provider: str | None = None
    processing_backend: ProcessingBackend = ProcessingBackend.LOCAL
    kaggle_url: str | None = None
    kaggle_token: str | None = None

    def __post_init__(self) -> None:
        if self.cpu_threads < 1:
            raise ValueError("cpu_threads must be positive")
