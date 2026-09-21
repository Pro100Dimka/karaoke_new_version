from __future__ import annotations

from dataclasses import dataclass, replace

import hashlib
import threading

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.processing.domain import Job, JobType, ProcessingMode, ProcessingOptions
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import ExecutionContext
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.processing.orchestrator import PipelineOrchestrator
from backend.processing.persistence import ProcessingPersistence
from backend.processing.preflight import ProcessingPreflight, ProcessingProviders
from backend.processing.reporting import report_payload
from backend.processing.resource_scheduler import ProcessingResourceScheduler, ResourceLease
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.settings.queries import GetSettings
from backend.songs.domain import Song, SongStatus
from backend.songs.ports import SongStorage

_ALLOWED_START_STATES = frozenset(
    {
        SongStatus.IMPORTED,
        SongStatus.READY,
        SongStatus.FAILED,
        SongStatus.CANCELLED,
        SongStatus.PROJECT_INVALID,
    }
)


_QUEUE_POLL_SECONDS = 1.0


@dataclass(slots=True)
class _Admission:
    """The resource lease a queued job receives once it is admitted."""

    lease: ResourceLease | None = None

    def execution(self) -> ExecutionContext:
        if self.lease is None:
            raise ConflictError("NotAdmitted", "Processing started without reserved resources")
        return self.lease.execution


class StartProcessing:
    def __init__(
        self,
        jobs: ProcessingJobManager,
        pipeline: PipelineOrchestrator,
        settings: GetSettings,
        preflight: ProcessingPreflight,
        storage: SongStorage,
        resources: ProcessingResourceScheduler,
        operations: SongOperationRegistry,
        persistence: ProcessingPersistence,
    ) -> None:
        self._jobs = jobs
        self._pipeline = pipeline
        self._settings = settings
        self._preflight = preflight
        self._storage = storage
        self._resources = resources
        self._operations = operations
        self._persistence = persistence

    def execute(
        self,
        song_id: str,
        mode: ProcessingMode,
        *,
        online_lyrics: bool,
        idempotency_key: str | None,
        correlation_id: str | None,
    ) -> Job:
        request_hash = _request_hash(song_id, mode, online_lyrics)
        repeated = self._persistence.repeated_job("StartProcessing", idempotency_key, request_hash)
        if repeated:
            return repeated
        job = self._launch(song_id, mode, online_lyrics, correlation_id)
        self._persistence.save_idempotency(
            "StartProcessing", idempotency_key, request_hash, job.job_id
        )
        return job

    def _launch(
        self,
        song_id: str,
        mode: ProcessingMode,
        online_lyrics: bool,
        correlation_id: str | None,
    ) -> Job:
        song = self._load_processable(song_id)
        settings = self._settings.execute()
        providers = self._preflight.execute(settings)
        try:
            return self._start_job(
                song, mode, online_lyrics, providers, settings.compute_mode, correlation_id
            )
        except DomainError:
            self._operations.release(song_id, SongOperation.PROCESSING)
            self._persistence.set_status(song_id, song.status)
            raise

    def _start_job(
        self,
        song: Song,
        mode: ProcessingMode,
        online_lyrics: bool,
        providers: ProcessingProviders,
        compute_mode: ComputeMode,
        correlation_id: str | None,
    ) -> Job:
        song_id = song.song_id
        source_bytes = self._source_size(song)
        admission = _Admission()
        self._operations.claim(song_id, SongOperation.PROCESSING)
        self._persistence.set_status(song_id, SongStatus.QUEUED)
        return self._jobs.start(
            JobType.SONG_PROCESSING,
            lambda context: self._run(
                song_id, mode, online_lyrics, providers, context, admission.execution()
            ),
            entity_id=song_id,
            mode=mode,
            correlation_id=correlation_id,
            on_finally=lambda: self._finish(song_id, admission),
            admit=lambda cancel: self._admit(
                admission, providers, source_bytes, compute_mode, cancel
            ),
        )

    def _admit(
        self,
        admission: "_Admission",
        providers: ProcessingProviders,
        source_bytes: int,
        compute_mode: ComputeMode,
        cancel: threading.Event,
    ) -> None:
        """Queues the job until the resource budget has room; a cancel while waiting simply ends the wait."""
        while not cancel.is_set():
            try:
                admission.lease = self._resources.claim(providers, source_bytes, compute_mode)
                return
            except DomainError as exc:
                if exc.code != "ResourceBudgetExceeded":
                    raise
                cancel.wait(_QUEUE_POLL_SECONDS)

    def _source_size(self, song: Song) -> int:
        if song.source_path is None:
            raise ConflictError("SourceMissing", "Managed source media is unavailable")
        return self._storage.size(song.source_path)

    def _finish(self, song_id: str, admission: "_Admission") -> None:
        try:
            self._operations.release(song_id, SongOperation.PROCESSING)
        finally:
            if admission.lease is not None:
                admission.lease.release()

    def _settle_unfinished(self, song_id: str) -> None:
        """A job that ended without publishing or cancelling (a bug in a stage) must not leave the song in Processing."""
        try:
            status = self._persistence.load_song(song_id).status
        except NotFoundError:
            return
        if status in {SongStatus.QUEUED, SongStatus.PROCESSING}:
            self._persistence.set_status_if_present(song_id, SongStatus.FAILED)

    def _run(
        self,
        song_id: str,
        mode: ProcessingMode,
        online_lyrics: bool,
        providers: ProcessingProviders,
        context: JobContext,
        execution: ExecutionContext,
    ) -> dict[str, object]:
        finished = False
        try:
            song = self._load_processable(song_id, allow_queued=True)
            self._persistence.set_status(song_id, SongStatus.PROCESSING)
            self._persistence.record_started(song_id)
            report = self._pipeline.run(
                song,
                ProcessingOptions(mode=mode, online_lyrics=online_lyrics),
                providers,
                context,
            )
            if execution.fallback_reason:
                # A CUDA to CPU fallback is never silent: it is part of the processing report.
                report = replace(report, warnings=(*report.warnings, execution.fallback_reason))
            finished = True
            return report_payload(report)
        except DomainError:
            status = SongStatus.CANCELLED if context.cancel.is_set() else SongStatus.FAILED
            self._persistence.set_status_if_present(song_id, status)
            raise
        finally:
            if not finished:
                self._settle_unfinished(song_id)

    def _load_processable(self, song_id: str, *, allow_queued: bool = False) -> Song:
        song = self._persistence.load_song(song_id)
        extra = {SongStatus.QUEUED} if allow_queued else set()
        if song.status not in _ALLOWED_START_STATES | extra:
            raise ConflictError(
                "ProcessingAlreadyRunning",
                "Song cannot start another processing operation",
            )
        if song.source_path is None or not self._storage.exists(song.source_path):
            raise ConflictError("SourceMissing", "Managed source media is unavailable")
        return song


def _request_hash(song_id: str, mode: ProcessingMode, online_lyrics: bool) -> str:
    raw = f"{song_id}\0{mode.value}\0{int(online_lyrics)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
