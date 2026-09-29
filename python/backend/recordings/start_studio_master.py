from __future__ import annotations

from pathlib import Path

from backend.ai.domain import AiCapability
from backend.ai.ports import AiProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.domain_errors import DomainError, NotFoundError
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.models.domain import ComputeMode
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from backend.projects.ports import ProjectStorage
from backend.recordings.domain import Recording
from backend.recordings.ports import RecordingFileInspector, RecordingStorage
from backend.recordings.register_recording import RegisterRecording, RegisterRecordingRequest
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.runtime import Clock, IdGenerator
from backend.settings.domain import ProcessingBackend
from backend.settings.queries import GetSettings

_KAGGLE_PROVIDER = "kaggle-p100"


class StartStudioMaster:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        jobs: ProcessingJobManager,
        projects: ProjectStorage,
        resolver: ResolveAiProvider,
        settings: GetSettings,
        resources: ProcessingResourceScheduler,
        workspaces: LocalWorkStorage,
        renderer: FfmpegStudioMasterRenderer,
        publisher: "PublishStudioMaster",
    ) -> None:
        self._uow = uow
        self._jobs = jobs
        self._projects = projects
        self._resolver = resolver
        self._settings = settings
        self._resources = resources
        self._workspaces = workspaces
        self._renderer = renderer
        self._publisher = publisher

    def execute(self, recording_id: str) -> Job:
        recording = self._recording(recording_id)
        self._project_identity(recording)
        settings = self._settings.execute()
        preferred = (
            _KAGGLE_PROVIDER
            if settings.processing_backend is ProcessingBackend.KAGGLE
            else settings.selected_separation_provider
        )
        provider = self._resolver.execute(AiCapability.SEPARATION, preferred)
        compute_mode = (
            ComputeMode.CPU
            if settings.processing_backend is ProcessingBackend.KAGGLE
            else settings.compute_mode
        )
        return self._jobs.start(
            JobType.RECORDING_MASTERING,
            lambda context: self._run(recording, provider, compute_mode, settings.cpu_threads, context),
            entity_id=recording.recording_id,
            initial_report={"processingBackend": settings.processing_backend.value},
        )

    def _run(
        self,
        recording: Recording,
        provider: AiProvider,
        compute_mode: ComputeMode,
        cpu_threads: int,
        context: JobContext,
    ) -> dict[str, object]:
        workspace = self._workspaces.allocate(f"studio-{recording.recording_id}")
        lease = self._resources.claim_provider(
            provider, recording.file_path.stat().st_size, compute_mode, cpu_threads=cpu_threads
        )
        try:
            context.progress("SeparatingPerformance", 0.0, 0.1)
            separated = provider.separate(
                recording.file_path,
                workspace / "separation",
                context.cancel,
                execution=lease.execution,
            )
            context.progress("AnalyzingBalance", 1.0, 0.58)
            song_id, revision = self._project_identity(recording)
            temporary = workspace / "studio-master.wav"
            balance = self._renderer.render(
                separated.reference_vocal,
                separated.instrumental,
                self._projects.artifact_path(song_id, revision, "referenceVocal"),
                self._projects.artifact_path(song_id, revision, "instrumental"),
                temporary,
                context.cancel,
            )
            context.progress("PublishingStudioMaster", 1.0, 0.92)
            master = self._publisher.execute(recording, temporary, balance.payload())
            return {"recordingId": master.recording_id, "balance": balance.payload()}
        finally:
            lease.release()
            self._workspaces.cleanup(workspace)

    def _recording(self, recording_id: str) -> Recording:
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if recording is None:
            raise NotFoundError("RecordingNotFound", "Recording was not found")
        return recording

    @staticmethod
    def _project_identity(recording: Recording) -> tuple[str, int]:
        if recording.song_id is None or recording.song_revision is None:
            raise DomainError(
                "StudioMasterUnavailable",
                "Studio mastering requires a recording linked to a processed song",
                409,
            )
        return recording.song_id, recording.song_revision


class PublishStudioMaster:
    def __init__(
        self,
        storage: RecordingStorage,
        inspector: RecordingFileInspector,
        register: RegisterRecording,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._storage = storage
        self._inspector = inspector
        self._register = register
        self._clock = clock
        self._ids = ids

    def execute(
        self, source: Recording, temporary: Path, balance: dict[str, float]
    ) -> Recording:
        recording_id = self._ids.new()
        target = self._storage.publish_file(recording_id, temporary)
        metadata = self._inspector.inspect(target)
        return self._register.execute(
            RegisterRecordingRequest(
                recording_id=recording_id,
                file_path=target,
                duration=metadata.duration,
                sample_rate=metadata.sample_rate,
                channels=metadata.channels,
                created_at=self._clock.now(),
                song_id=source.song_id,
                song_revision=source.song_revision,
                session_metadata={
                    "studioMaster": {
                        "sourceRecordingId": source.recording_id,
                        "balance": balance,
                    }
                },
                display_name=f"Studio Master · {source.display_name or 'Take'}",
            )
        )
