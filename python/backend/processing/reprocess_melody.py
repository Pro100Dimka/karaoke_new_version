from __future__ import annotations

import hashlib

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.domain_errors import ConflictError
from backend.models.domain import ComputeMode
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.processing.compute_policy import ExecutionContext
from backend.processing.melody_pipeline import MelodyInputs, MelodyPipeline
from backend.processing.persistence import ProcessingPersistence
from backend.processing.preflight import ProcessingPreflight, provider_backend
from backend.processing.reporting import report_payload
from backend.processing.resource_scheduler import ProcessingResourceScheduler, ResourceLease
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.settings.queries import SettingsReader
from backend.settings.domain import ProcessingBackend
from backend.songs.domain import SongStatus


class ReprocessMelody:
    def __init__(
        self,
        jobs: ProcessingJobManager,
        settings: SettingsReader,
        resolver: ResolveAiProvider,
        resources: ProcessingResourceScheduler,
        pipeline: MelodyPipeline,
        operations: SongOperationRegistry,
        persistence: ProcessingPersistence,
    ) -> None:
        self._jobs = jobs
        self._settings = settings
        self._preflight = ProcessingPreflight(resolver)
        self._resources = resources
        self._pipeline = pipeline
        self._operations = operations
        self._persistence = persistence

    def execute(
        self,
        song_id: str,
        *,
        idempotency_key: str | None,
        correlation_id: str | None,
        realign_lyrics: bool = False,
    ) -> Job:
        request_hash = _request_hash(song_id, "lyrics" if realign_lyrics else "melody")
        repeated = self._persistence.repeated_job("ReprocessMelody", idempotency_key, request_hash)
        if repeated:
            return repeated

        song = self._persistence.load_song(song_id)
        if song.status is not SongStatus.READY:
            raise ConflictError(
                "ProjectInvalid",
                "Melody reprocess requires a Ready project",
            )
        inputs = self._pipeline.load_inputs(song)
        settings = self._settings()
        provider = self._preflight.resolve(settings, AiCapability.PITCH)
        alignment = (
            self._preflight.resolve(settings, AiCapability.ALIGNMENT) if realign_lyrics else None
        )
        lease = self._resources.claim_provider(
            provider,
            self._pipeline.resource_size(inputs),
            ComputeMode.CPU
            if provider_backend(provider) is ProcessingBackend.KAGGLE
            else settings.compute_mode,
            cpu_threads=settings.cpu_threads,
            additional_providers=(alignment,) if alignment else (),
        )
        job = self._start(inputs, provider, alignment, lease, correlation_id)
        self._persistence.save_idempotency(
            "ReprocessMelody", idempotency_key, request_hash, job.job_id
        )
        return job

    def _start(
        self,
        inputs: MelodyInputs,
        provider: AiProvider,
        alignment: AiProvider | None,
        lease: ResourceLease,
        correlation_id: str | None,
    ) -> Job:
        song_id = inputs.song.song_id
        claimed = submitted = False
        try:
            self._operations.claim(song_id, SongOperation.PROCESSING)
            claimed = True
            job = self._jobs.start(
                JobType.SONG_PROCESSING,
                lambda context: self._run(inputs, provider, alignment, context, lease.execution),
                entity_id=song_id,
                correlation_id=correlation_id,
                initial_report={
                    "songTitle": inputs.song.title,
                    "songArtist": inputs.song.artist,
                    "processingBackend": provider_backend(provider).value,
                    "timingOperation": "lyrics" if alignment else "melody",
                },
                on_finally=lambda: self._finish(song_id, lease),
            )
            submitted = True
            return job
        finally:
            if not submitted:
                lease.release()
                if claimed:
                    self._operations.release(song_id, SongOperation.PROCESSING)

    def _run(
        self,
        inputs: MelodyInputs,
        provider: AiProvider,
        alignment: AiProvider | None,
        context: JobContext,
        execution: ExecutionContext,
    ) -> dict[str, object]:
        self._persistence.record_started(
            inputs.song.song_id,
            kind="LyricsRealignment" if alignment else "MelodyReprocess",
        )
        return report_payload(self._pipeline.run(inputs, provider, context, execution, alignment))

    def _finish(self, song_id: str, lease: ResourceLease) -> None:
        try:
            self._operations.release(song_id, SongOperation.PROCESSING)
        finally:
            lease.release()


def _request_hash(song_id: str, operation: str = "melody") -> str:
    return hashlib.sha256(f"{song_id}\0{operation}".encode("utf-8")).hexdigest()
