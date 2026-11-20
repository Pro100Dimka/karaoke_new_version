from __future__ import annotations

from pathlib import Path
import logging
from collections.abc import Callable, Iterator, Sequence, Mapping
from contextlib import contextmanager

from backend.ai.domain import AiCapability, PitchPoint
from backend.ai.provider_resolver import ResolveAiProvider
from backend.domain_errors import DomainError, NotFoundError
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.infrastructure.atomic_files import atomic_write_text
from backend.serialization import dumps
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from backend.projects.ports import ProjectStorage
from backend.recordings.domain import Recording, recording_adjustments
from backend.recordings.ports import RecordingFileInspector, RecordingStorage
from backend.recordings.register_recording import RegisterRecording, RegisterRecordingRequest
from backend.recordings.studio_master import FfmpegStudioMasterRenderer, recording_stems
from backend.recordings.studio_audio import StudioMasterBalance
from backend.recordings.studio_pitch_analysis import analyze_pitch
from backend.recordings.studio_pitch_prefetch import LocalPitchAnalyzer
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
            context.progress("PreparingStudioSources", 0.0, 0.55)
            temporary = workspace / "studio-master.wav"
            balance = self._render(recording, stems, exact_stems, temporary, context)
            context.ensure_not_cancelled()
            context.progress("PublishingStudioMaster", 1.0, 0.92)
            master = self._publisher.execute(recording, temporary, balance.payload())
            return {"recordingId": master.recording_id, "balance": balance.payload()}
        finally:
            self._workspaces.cleanup(workspace)

    def _render(
        self,
        recording: Recording,
        stems: tuple[Path, Path],
        exact_stems: bool,
        temporary: Path,
        context: JobContext,
    ) -> StudioMasterBalance:
        song_id, revision = self._project_identity(recording)
        with self._render_budget(recording) as workers, self._pitch_session(context) as pitch:
            return self._renderer.render(
                *stems,
                self._projects.artifact_path(song_id, revision, "referenceVocal"),
                self._projects.artifact_path(song_id, revision, "instrumental"),
                temporary,
                context.cancel,
                performance_mix=recording.file_path,
                exact_stems=exact_stems,
                process_voice=exact_stems and stems[0].name.endswith(".dry.wav"),
                match_recording_loudness=True,
                adjustments=recording_adjustments(recording),
                progress=context.progress,
                # Shared room stems can contain simultaneous singers on different notes.
                pitch=None if "roomPerformance" in (recording.session_metadata or {}) else pitch,
                original_mix=self._original_mix(song_id, revision),
                workers=workers,
            )

    @contextmanager
    def _render_budget(self, recording: Recording) -> Iterator[int]:
        lease = self._resources.claim_cpu(
            recording.file_path.stat().st_size, cpu_threads=self._settings().cpu_threads
        )
        try:
            yield lease.execution.cpu_threads
        finally:
            lease.release()

    def _original_mix(self, song_id: str, revision: int) -> Path | None:
        """The local original is optional; portable projects still have reference stems."""
        try:
            reference = self._projects.artifact_path(song_id, revision, "source")
        except NotFoundError:
            return None
        if not reference.is_file():
            return None
        try:
            source = Path(reference.read_text(encoding="utf-8").strip())
            return source if source.is_file() else None
        except (OSError, ValueError, UnicodeError):
            logger.info("Original mix is unavailable for Studio Master: song=%s", song_id)
            return None

    @contextmanager
    def _pitch_session(
        self, context: JobContext
    ) -> Iterator[Callable[[Path], Sequence[PitchPoint]]]:
        def pitch(vocal: Path) -> Sequence[PitchPoint]:
            context.ensure_not_cancelled()
            return analyze_pitch(vocal, context.cancel)

        # The renderer may prefetch its trusted reference inside the same budget.
        # Session ownership drains speculative reads even if pitch is skipped.
        analyzer = LocalPitchAnalyzer(context.cancel, pitch)
        try:
            yield analyzer
        finally:
            analyzer.close()

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
            audio = self._separation_source(recording, workspace, context)
            separated = provider.separate(
                audio,
                workspace / "separation",
                context.cancel,
                execution=lease.execution,
            )
            return separated.reference_vocal, separated.instrumental
        finally:
            lease.release()

    def _separation_source(
        self, recording: Recording, workspace: Path, context: JobContext
    ) -> Path:
        source = recording.file_path
        if recording.channels <= 2 or not self._renderer._repeated_output_channels(
            source, context.cancel
        ):
            return source
        target = workspace / "original-stereo.wav"
        self._renderer._mix(
            source,
            source,
            "[0:a]pan=stereo|c0=c0|c1=c1[out]",
            ["-c:a", "pcm_f32le", str(target)],
            context.cancel,
        )
        return target

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
        seen: set[str] = set()
        while True:
            if recording_id in seen:
                raise DomainError(
                    "StudioMasterSourceCycle", "Original recording chain is cyclic", 409
                )
            seen.add(recording_id)
            with self._uow.create() as transaction:
                recording = transaction.recordings.get(recording_id)
            if recording is None:
                raise NotFoundError("RecordingNotFound", "Original recording was not found")
            master = (recording.session_metadata or {}).get("studioMaster")
            if master is None:
                break
            source_id = master.get("sourceRecordingId") if isinstance(master, Mapping) else None
            if not isinstance(source_id, str) or not source_id:
                raise DomainError(
                    "StudioMasterSourceMissing", "Master has no original recording link", 409
                )
            recording_id = source_id
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
