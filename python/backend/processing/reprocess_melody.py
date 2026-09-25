from __future__ import annotations

import hashlib

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.domain_errors import ConflictError
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.processing.compute_policy import ExecutionContext
from backend.processing.melody_pipeline import MelodyInputs, MelodyPipeline
from backend.processing.persistence import ProcessingPersistence
from backend.processing.reporting import report_payload
from backend.processing.resource_scheduler import ProcessingResourceScheduler, ResourceLease
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.settings.queries import GetSettings
from backend.songs.domain import SongStatus


class ReprocessMelody:
    def __init__(
        self,
        jobs: ProcessingJobManager,
        settings: GetSettings,
        resolver: ResolveAiProvider,
        resources: ProcessingResourceScheduler,
        pipeline: MelodyPipeline,
        operations: SongOperationRegistry,
        persistence: ProcessingPersistence,
    ) -> None:
        self._jobs = jobs
        self._settings = settings
        self._resolver = resolver
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
    ) -> Job:
        request_hash = _request_hash(song_id)
        repeated = self._persistence.repeated_job(
            "ReprocessMelody",
            idempotency_key,
            request_hash,
        )
        if repeated:
            return repeated

        song = self._persistence.load_song(song_id)
        if song.status is not SongStatus.READY:
            raise ConflictError(
                "ProjectInvalid",
                "Melody reprocess requires a Ready project",
            )
        inputs = self._pipeline.load_inputs(song)
        provider = self._provider()
        lease = self._resources.claim_provider(
            provider,
            self._pipeline.resource_size(inputs),
            self._settings.execute().compute_mode,
            cpu_threads=self._settings.execute().cpu_threads,
        )
        job = self._start(inputs, provider, lease, correlation_id)
        self._persistence.save_idempotency(
            "ReprocessMelody",
            idempotency_key,
            request_hash,
            job.job_id,
        )
        return job

    def _start(
        self,
        inputs: MelodyInputs,
        provider: AiProvider,
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
                lambda context: self._run(inputs, provider, context, lease.execution),
                entity_id=song_id,
                correlation_id=correlation_id,
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
        context: JobContext,
        execution: ExecutionContext,
    ) -> dict[str, object]:
        self._persistence.record_started(
            inputs.song.song_id,
            kind="MelodyReprocess",
        )
        return report_payload(self._pipeline.run(inputs, provider, context, execution))

    def _provider(self) -> AiProvider:
        settings = self._settings.execute()
        return self._resolver.execute(
            AiCapability.PITCH,
            settings.selected_pitch_provider,
        )

    def _finish(self, song_id: str, lease: ResourceLease) -> None:
        try:
            self._operations.release(song_id, SongOperation.PROCESSING)
        finally:
            lease.release()


def _request_hash(song_id: str) -> str:
    return hashlib.sha256(f"{song_id}\0melody".encode("utf-8")).hexdigest()
