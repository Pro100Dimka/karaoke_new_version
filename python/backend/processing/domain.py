from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum
from types import MappingProxyType
from typing import Mapping


class ProcessingMode(StrEnum):
    AUTO = "Auto"
    FAST = "Fast"
    QUALITY = "Quality"


class JobState(StrEnum):
    QUEUED = "Queued"
    RUNNING = "Running"
    CANCELLING = "Cancelling"
    CANCELLED = "Cancelled"
    SUCCEEDED = "Succeeded"
    FAILED = "Failed"
    INTERRUPTED = "Interrupted"


class JobType(StrEnum):
    SONG_PROCESSING = "SongProcessing"
    RECORDING_ANALYSIS = "RecordingAnalysis"
    MODEL_DOWNLOAD = "ModelDownload"
    PACKAGE_IMPORT = "PackageImport"
    PACKAGE_EXPORT = "PackageExport"
    LIBRARY_RECONCILIATION = "LibraryReconciliation"


_TERMINAL_STATES = frozenset({JobState.CANCELLED, JobState.SUCCEEDED, JobState.FAILED})
_ALLOWED_TRANSITIONS: Mapping[JobState, frozenset[JobState]] = MappingProxyType(
    {
        JobState.QUEUED: frozenset({JobState.RUNNING, JobState.CANCELLED, JobState.INTERRUPTED}),
        JobState.RUNNING: frozenset(
            {JobState.CANCELLING, JobState.SUCCEEDED, JobState.FAILED, JobState.INTERRUPTED}
        ),
        JobState.CANCELLING: frozenset({JobState.CANCELLED, JobState.FAILED, JobState.INTERRUPTED}),
        JobState.INTERRUPTED: frozenset({JobState.QUEUED, JobState.CANCELLED, JobState.FAILED}),
        JobState.CANCELLED: frozenset(),
        JobState.SUCCEEDED: frozenset(),
        JobState.FAILED: frozenset(),
    }
)


@dataclass(frozen=True, slots=True)
class Job:
    job_id: str
    job_type: JobType
    state: JobState
    created_at: datetime
    updated_at: datetime
    entity_id: str | None = None
    mode: ProcessingMode | None = None
    correlation_id: str | None = None
    stage: str | None = None
    stage_progress: float = 0.0
    overall_progress: float = 0.0
    eta_seconds: float | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    error: Mapping[str, object] | None = None
    report: Mapping[str, object] | None = None

    @property
    def terminal(self) -> bool:
        return self.state in _TERMINAL_STATES

    def transition(self, state: JobState, now: datetime) -> "Job":
        if state not in _ALLOWED_TRANSITIONS[self.state]:
            raise ValueError(f"Invalid job transition: {self.state} -> {state}")
        started_at = self.started_at or (now if state is JobState.RUNNING else None)
        finished_at = now if state in _TERMINAL_STATES else self.finished_at
        return replace(
            self, state=state, updated_at=now, started_at=started_at, finished_at=finished_at
        )


@dataclass(frozen=True, slots=True)
class ProcessingOptions:
    mode: ProcessingMode
    online_lyrics: bool = True
    melody_only: bool = False


class CancellationPolicy(StrEnum):
    INTERRUPTIBLE = "Interruptible"
    FINISH_BEFORE_CANCEL = "FinishBeforeCancel"


@dataclass(frozen=True, slots=True)
class StageReport:
    stage: str
    duration_seconds: float
    cancellation_policy: CancellationPolicy


@dataclass(frozen=True, slots=True)
class ProcessingReport:
    song_id: str
    revision: int
    stages: tuple[StageReport, ...]
    providers: Mapping[str, str]
    cache_used: bool
    warnings: tuple[str, ...]
    algorithm_version: str
