from __future__ import annotations

from pathlib import Path
import logging
from collections.abc import Callable, Iterator, Sequence
from contextlib import ExitStack, contextmanager
from functools import partial

from backend.ai.domain import AiCapability, PitchPoint
from backend.ai.ports import AiProvider, PitchReuseProvider
from backend.ai.provider_resolver import ResolveAiProvider
from backend.domain_errors import DomainError, NotFoundError
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.infrastructure.atomic_files import atomic_write_text
from backend.serialization import dumps
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.processing.resource_scheduler import ProcessingResourceScheduler, ResourceLease
from backend.projects.ports import ProjectStorage
from backend.recordings.domain import Recording, recording_adjustments
from backend.recordings.ports import RecordingFileInspector, RecordingStorage
from backend.recordings.register_recording import RegisterRecording, RegisterRecordingRequest
from backend.recordings.studio_master import FfmpegStudioMasterRenderer, recording_stems
from backend.runtime import Clock, IdGenerator
from backend.settings.domain import ProcessingBackend
from backend.settings.queries import SettingsReader

_KAGGLE_PROVIDER = "kaggle-p100"
logger = logging.getLogger(__name__)


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
        song_id, revision = self._project_identity(recording)
        for artifact in ("referenceVocal", "instrumental"):
            if not self._projects.artifact_path(song_id, revision, artifact).is_file():
                raise NotFoundError(
                    "StudioMasterUnavailable", "Original song stems are unavailable"
                )
        # Recover older recordings with only a backing track before deciding to
        # run costly source separation. The original take remains untouched.
        stems = self._stems(recording)
        logger.info("Studio Master requested: recording=%s stems=%s", recording_id, bool(stems))
        return self._jobs.start(
            JobType.RECORDING_MASTERING,
            lambda context: self._run(recording, context),
            entity_id=recording.recording_id,
            initial_report={
                "processingBackend": ProcessingBackend.LOCAL.value,
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
            stems = self._stems(recording)
            exact_stems = stems is not None
            if stems is None:
                stems = self._separate(recording, workspace, context)
            context.progress("AnalyzingBalance", 1.0, 0.58)
            song_id, revision = self._project_identity(recording)
            temporary = workspace / "studio-master.wav"
            adjustments = recording_adjustments(recording)
            with self._pitch_session(context) as pitch:
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
                    pitch=pitch,
                )
            context.ensure_not_cancelled()
            context.progress("PublishingStudioMaster", 1.0, 0.92)
            master = self._publisher.execute(recording, temporary, balance.payload())
            return {"recordingId": master.recording_id, "balance": balance.payload()}
        finally:
            self._workspaces.cleanup(workspace)

    @contextmanager
    def _pitch_session(
        self, context: JobContext
    ) -> Iterator[Callable[[Path], Sequence[PitchPoint]]]:
        with ExitStack() as scope:
            analyze: Callable[[Path], Sequence[PitchPoint]] | None = None

            def pitch(vocal: Path) -> Sequence[PitchPoint]:
                nonlocal analyze
                context.ensure_not_cancelled()
                if analyze is None:
                    provider, lease = self._pitch_provider(vocal, context)
                    scope.callback(lease.release)
                    if isinstance(provider, PitchReuseProvider):
                        scope.enter_context(provider.reuse_pitch(context.cancel, lease.execution))
                    analyze = partial(
                        provider.pitch, cancel=context.cancel, execution=lease.execution
                    )
                return analyze(vocal)

            yield pitch

    def _pitch_provider(self, vocal: Path, context: JobContext) -> tuple[AiProvider, ResourceLease]:
        context.ensure_not_cancelled()
        settings = self._settings()
        preferred = settings.selected_pitch_provider
        provider = self._resolver.execute(
            AiCapability.PITCH, None if preferred == _KAGGLE_PROVIDER else preferred
        )
        lease = self._resources.claim_provider(
            provider, vocal.stat().st_size, settings.compute_mode, cpu_threads=settings.cpu_threads
        )
        return provider, lease

    def _separate(
        self, recording: Recording, workspace: Path, context: JobContext
    ) -> tuple[Path, Path]:
        context.progress("SeparatingPerformance", 0.0, 0.1)
        settings = self._settings()
        # Studio Master never starts Kaggle implicitly. Only an explicit
        # user-initiated Kaggle action may activate the remote runtime.
        provider = self._resolver.execute(
            AiCapability.SEPARATION,
            None
            if settings.selected_separation_provider == _KAGGLE_PROVIDER
            else settings.selected_separation_provider,
        )
        lease = self._resources.claim_provider(
            provider,
            recording.file_path.stat().st_size,
            settings.compute_mode,
            cpu_threads=settings.cpu_threads,
        )
        try:
            separated = provider.separate(
                recording.file_path,
                workspace / "separation",
                context.cancel,
                execution=lease.execution,
            )
            return separated.reference_vocal, separated.instrumental
        finally:
            lease.release()

    def _stems(self, recording: Recording) -> tuple[Path, Path] | None:
        stems = recording_stems(recording.file_path, prefer_dry=True)
        if stems is not None:
            return stems
        backing = Path(str(recording.file_path) + ".backing.wav")
        if backing.is_file():
            self._renderer.preserve_stems(recording.file_path)
            return recording_stems(recording.file_path, prefer_dry=True)
        return None

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
        on_completed: Callable[[str], None] | None = None,
    ) -> None:
        self._storage = storage
        self._inspector = inspector
        self._register = register
        self._clock = clock
        self._ids = ids
        self._on_completed = on_completed

    def execute(self, source: Recording, temporary: Path, balance: dict[str, object]) -> Recording:
        recording_id = self._ids.new()
        target = self._storage.publish_file(recording_id, temporary)
        metadata = self._inspector.inspect(target)
        atomic_write_text(
            target.with_suffix(".studio.json"),
            dumps({"sourceRecordingId": source.recording_id, "balance": balance}, pretty=True),
        )
        master = self._register.execute(
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
                    },
                },
                # Named by the interface in its own language from the take it masters.
                display_name=None,
            )
        )
        if self._on_completed:
            self._on_completed(master.recording_id)
        return master
