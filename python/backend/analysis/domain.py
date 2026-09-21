from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Mapping, Sequence


class AnalysisState(StrEnum):
    NOT_STARTED = "NotStarted"
    QUEUED = "Queued"
    RUNNING = "Running"
    SUCCEEDED = "Succeeded"
    FAILED = "Failed"
    STALE = "Stale"


@dataclass(frozen=True, slots=True)
class SectionResult:
    start: float
    end: float
    pitch_accuracy_percent: float
    mean_semitone_deviation: float


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    analysis_id: str
    recording_id: str
    song_id: str
    song_revision: int
    algorithm_version: str
    state: AnalysisState
    created_at: datetime
    updated_at: datetime
    recording_identity: str
    pitch_accuracy_percent: float | None = None
    mean_semitone_deviation: float | None = None
    section_results: Sequence[SectionResult] = ()
    problem_regions: Sequence[Mapping[str, float]] = ()
    error: Mapping[str, object] | None = None
