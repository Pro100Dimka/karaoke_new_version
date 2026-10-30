from __future__ import annotations

from pathlib import Path
from collections.abc import Callable, Mapping

from backend.ai.domain import AiCapability
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
from backend.recordings.studio_master import FfmpegStudioMasterRenderer, recording_stems
from backend.runtime import Clock, IdGenerator
from backend.settings.domain import ProcessingBackend
from backend.settings.queries import SettingsReader

_KAGGLE_PROVIDER = "kaggle-p100"


class StartStudioMaster:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        jobs: ProcessingJobManager,
        projects: ProjectStorage,
        resolver: ResolveAiProvider,
        settings: SettingsReader,
        resources: ProcessingResourceScheduler,
        workspaces: LocalWorkStorage,
        renderer: FfmpegStudioMasterRenderer,
        publisher: "PublishStudioMaster",
        on_completed: Callable[[str], None] | None = None,
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
        self._on_completed = on_completed

    def execute(self, recording_id: str) -> Job:
        recording = self._recording(recording_id)
        song_id, revision = self._project_identity(recording)
        for artifact in ("referenceVocal", "instrumental"):
            if not self._projects.artifact_path(song_id, revision, artifact).is_file():
                raise NotFoundError("StudioMasterUnavailable", "Original song stems are unavailable")
        stems = recording_stems(recording.file_path, prefer_dry=True)
        return self._jobs.start(
            JobType.RECORDING_MASTERING,
            lambda context: self._run(recording, context),
            entity_id=recording.recording_id,
            initial_report={
                "processingBackend": ProcessingBackend.LOCAL.value if stems
                else self._settings().processing_backend.value,
            },
        )

    def _run(
        self,
        recording: Recording,
        context: JobContext,
    ) -> dict[str, object]:
        recording = self._recording(recording.recording_id)
        workspace = self._workspaces.allocate(f"studio-{recording.recording_id}")
        try:
            context.ensure_not_cancelled()
            stems = recording_stems(recording.file_path, prefer_dry=True)
            exact_stems = stems is not None
            if stems is None:
                context.progress("SeparatingPerformance", 0.0, 0.1)
                settings = self._settings()
                remote = settings.processing_backend is ProcessingBackend.KAGGLE
                provider = self._resolver.execute(
                    AiCapability.SEPARATION,
                    _KAGGLE_PROVIDER if remote else settings.selected_separation_provider,
                )
                lease = self._resources.claim_provider(
                    provider, recording.file_path.stat().st_size,
                    ComputeMode.CPU if remote else settings.compute_mode,
                    cpu_threads=settings.cpu_threads,
                )
                try:
                    separated = provider.separate(
                        recording.file_path, workspace / "separation", context.cancel,
                        execution=lease.execution,
                    )
                    stems = separated.reference_vocal, separated.instrumental
                finally:
                    lease.release()
            context.progress("AnalyzingBalance", 1.0, 0.58)
            song_id, revision = self._project_identity(recording)
            temporary = workspace / "studio-master.wav"
            raw_adjustments = (recording.session_metadata or {}).get("playbackAdjustments", ())
            adjustments = (
                [item if isinstance(item, Mapping) else {} for item in raw_adjustments]
                if isinstance(raw_adjustments, (list, tuple)) else [{}]
            )
            balance = self._renderer.render(
                *stems,
                self._projects.artifact_path(song_id, revision, "referenceVocal"),
                self._projects.artifact_path(song_id, revision, "instrumental"),
                temporary,
                context.cancel,
                performance_mix=recording.file_path,
                exact_stems=exact_stems,
                process_voice=exact_stems and stems[0].name.endswith(".dry.wav"),
                match_recording_loudness=True,
                adjustments=adjustments,
                progress=context.progress,
            )
            context.ensure_not_cancelled()
            context.progress("PublishingStudioMaster", 1.0, 0.92)
            master = self._publisher.execute(recording, temporary, balance.payload())
            if self._on_completed:
                self._on_completed(master.recording_id)
            return {"recordingId": master.recording_id, "balance": balance.payload()}
        finally:
            self._workspaces.cleanup(workspace)

    def _recording(self, recording_id: str) -> Recording:
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if recording is None:
            raise NotFoundError("RecordingNotFound", "Recording was not found")
        if not recording.file_path.is_file():
            raise NotFoundError("RecordingFileMissing", "Recording file is unavailable")
        if recording.file_status != "Ready":
            raise DomainError("StudioMasterUnavailable", "Recording is not finalized", 409)
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

    def execute(self, source: Recording, temporary: Path, balance: dict[str, object]) -> Recording:
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
                allow_historical_revision=True,
                gaps=source.gaps,
                session_metadata={
                    **(source.session_metadata or {}),
                    "studioMaster": {
                        "sourceRecordingId": source.recording_id,
                        "balance": balance,
                    }
                },
                # Named by the interface in its own language from the take it masters.
                display_name=None,
            )
        )
