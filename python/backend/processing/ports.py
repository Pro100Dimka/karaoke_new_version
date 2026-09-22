from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable, Mapping, Protocol, Sequence

from backend.processing.algorithms import MusicMetadata
from backend.processing.domain import Job, JobType

ProgressCallback = Callable[[str, float, float], None]


class JobRepository(Protocol):
    def get(self, job_id: str) -> Job | None: ...

    def add(self, job: Job) -> None: ...

    def update(self, job: Job) -> None: ...

    def list(
        self, *, limit: int, offset: int, job_type: JobType | None = None
    ) -> Sequence[Job]: ...

    def count(self, *, job_type: JobType | None = None) -> int: ...

    def mark_running_interrupted(self) -> int: ...


class JobExecutor(Protocol):
    def submit(self, job_id: str, work: Callable[[threading.Event], None]) -> None: ...

    def cancel(self, job_id: str) -> bool: ...

    def stop_accepting(self) -> None: ...

    def shutdown(self) -> None: ...

    def stats(self) -> Mapping[str, int]: ...


class AudioNormalizer(Protocol):
    def normalize(
        self, source: Path, target: Path, *, threads: int, cancel: threading.Event
    ) -> None: ...


class ProcessingCache(Protocol):
    def get(self, key: str) -> Path | None: ...

    def put(self, key: str, source: Path) -> Path: ...

    def delete(self, key: str) -> None: ...


class MusicAnalyzer(Protocol):
    def analyze(self, audio: Path) -> MusicMetadata: ...


class ConcurrentRunner(Protocol):
    """Runs independent steps of an already-running job's own work in parallel (see
    BuildProcessingDocument) -- distinct from JobExecutor, which schedules whole jobs onto its own
    bounded worker pool. Waits for every task and re-raises the first exception any of them raised."""

    def run_concurrently(self, *tasks: Callable[[], None]) -> None: ...
