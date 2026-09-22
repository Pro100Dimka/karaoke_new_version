from __future__ import annotations

from collections.abc import Sequence
from contextlib import ExitStack

from backend.ai.ports import AiProvider
from backend.ai.registry import AiProviderRegistry
from backend.bootstrap.config import BackendConfig
from backend.bootstrap.container import ApplicationContainer, SystemCases
from backend.bootstrap.model_wiring import build_model_cases
from backend.bootstrap.package_wiring import build_package_cases
from backend.bootstrap.recording_wiring import build_recording_cases
from backend.bootstrap.room_wiring import build_room_cases
from backend.bootstrap.song_wiring import build_song_cases
from backend.bootstrap.system_wiring import build_system_cases, set_ready_state, validated_settings
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.bootstrap.ai_wiring import (
    configured_ai_providers,
    declare_model_catalog,
    retrying_lyrics_providers,
)
from backend.bootstrap.lifecycle import BackendLifecycle
from backend.infrastructure.cached_runtime_probe import CachedRuntimeProbe
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.database import Database
from backend.infrastructure.event_stream import EventStream
from backend.infrastructure.ffmpeg_audio import FfmpegAudioValidator
from backend.infrastructure.file_hasher import Sha256FileHasher
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.audd_recognition import (
    AuddRecognitionProvider,
    DeezerCatalogRecognitionProvider,
    FallbackSongRecognitionProvider,
    ItunesCatalogRecognitionProvider,
    YoutubeVideoFinder,
)
from backend.infrastructure.shazam_recognition import ShazamRecognitionProvider
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.job_executor import BoundedJobExecutor
from backend.infrastructure.local_projects import LocalProjectStorage
from backend.infrastructure.local_songs import LocalSongStorage
from backend.infrastructure.local_storage import (
    LocalModelStorage,
    LocalStorageSystem,
    LocalWorkStorage,
)
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.recording_files import LocalRecordingStorage
from backend.infrastructure.recovery_journal import FileRecoveryJournal
from backend.infrastructure.runtime_probe import SystemRuntimeProbe
from backend.infrastructure.wave_recording import WaveRecordingInspector
from backend.lyrics.ports import OnlineLyricsProvider
from backend.songs.recognition import SongRecognitionProvider
from backend.processing.job_manager import ProcessingJobManager
from backend.projects.content_lock import KeyedLockManager
from backend.projects.operations import SongOperationRegistry
from backend.projects.validator import ProjectValidator
from backend.recordings.reconcile import ReconcileRecordings
from backend.recordings.register_recording import RegisterRecording
from backend.recovery.reconcile_library import ReconcileLibrary
from backend.recovery.recover_transactions import RecoverTransactions
from backend.recovery.reconcile_songs import ReconcileInterruptedSongs
from backend.recovery.startup_recovery import RecoverySummary, StartupRecovery
from backend.settings.queries import GetSettings


def build_container(
    config: BackendConfig,
    *,
    ai_providers: Sequence[AiProvider] = (),
    lyrics_providers: Sequence[OnlineLyricsProvider] = (),
    recognition_provider: SongRecognitionProvider | None = None,
) -> ApplicationContainer:
    clock = UtcClock()
    ids = UuidGenerator()
    lifecycle = BackendLifecycle()
    instance_lock = BackendInstanceLock(config.roots.app / "backend.lock")
    instance_lock.acquire()
    built = False
    try:
        container = _build_locked(
            config,
            ai_providers,
            lyrics_providers,
            recognition_provider,
            clock,
            ids,
            lifecycle,
            instance_lock,
        )
        declare_model_catalog(container.models.declare)
        built = True
        return container
    finally:
        if not built:
            instance_lock.release()


def _processing_wiring(
    config: BackendConfig,
    processes: ProcessRunner,
    jobs: ProcessingJobManager,
    ai_providers: Sequence[AiProvider],
    lyrics_providers: Sequence[OnlineLyricsProvider],
    storage: LocalStorageSystem,
) -> ProcessingWiring:
    runtime_probe = CachedRuntimeProbe(SystemRuntimeProbe(processes))
    # Providers injected by the caller replace the configured/built-in ones, so tests and embedders stay in control.
    registry = AiProviderRegistry(ai_providers or configured_ai_providers(config, processes))
    return ProcessingWiring(
        jobs,
        registry,
        retrying_lyrics_providers(lyrics_providers),
        LocalWorkStorage(config.roots.temp),
        runtime_probe,
        storage,
    )


def _build_locked(
    config: BackendConfig,
    ai_providers: Sequence[AiProvider],
    lyrics_providers: Sequence[OnlineLyricsProvider],
    recognition_provider: SongRecognitionProvider | None,
    clock: UtcClock,
    ids: UuidGenerator,
    lifecycle: BackendLifecycle,
    instance_lock: BackendInstanceLock,
) -> ApplicationContainer:
    storage = _initialized_storage(config, clock)
    with ExitStack() as startup:
        database = _open_database(config, startup)
        processes, hasher = ProcessRunner(), Sha256FileHasher()
        project = _project_wiring(config, database, processes, clock, ids, hasher)
        events = EventStream(clock)
        executor = _start_executor(config, startup)
        jobs = ProcessingJobManager(database, executor, clock, ids, events)
        processing = _processing_wiring(
            config, processes, jobs, ai_providers, lyrics_providers, storage
        )
        runtime = RuntimeWiring(config, database, processes, clock, ids, hasher)
        recording_storage, register = _recording_wiring(config, database, clock, ids)
        recovery = _startup_recovery(runtime, project, processing, recording_storage, register)
        container = _assemble_container(
            runtime,
            project,
            processing,
            recognition_provider,
            recording_storage,
            register,
            lifecycle,
            events,
            instance_lock,
            executor,
            recovery,
            validated_settings(database),
        )
        startup.pop_all()
        return container


def _initialized_storage(config: BackendConfig, clock: UtcClock) -> LocalStorageSystem:
    storage = LocalStorageSystem(config.roots, clock)
    storage.initialize()
    return storage


def _open_database(config: BackendConfig, startup: ExitStack) -> Database:
    database = Database(config.roots.database)
    startup.callback(database.dispose)
    DatabaseMigrator().migrate(database.engine)
    database.validate()
    return database


def _project_wiring(
    config: BackendConfig,
    database: Database,
    processes: ProcessRunner,
    clock: UtcClock,
    ids: UuidGenerator,
    hasher: Sha256FileHasher,
) -> ProjectWiring:
    projects = LocalProjectStorage(config.roots)
    songs = LocalSongStorage(config.roots)
    journal = FileRecoveryJournal(config.roots.recovery, clock, ids)
    validator = ProjectValidator(projects, hasher, FfmpegAudioValidator(processes))
    return ProjectWiring(
        projects, songs, validator, journal, KeyedLockManager(), SongOperationRegistry()
    )


def _start_executor(config: BackendConfig, startup: ExitStack) -> BoundedJobExecutor:
    executor = BoundedJobExecutor(
        config.resources.max_background_jobs,
        config.resources.queue_capacity,
    )
    executor.start()
    startup.callback(executor.shutdown)
    return executor


def _recording_wiring(
    config: BackendConfig,
    database: Database,
    clock: UtcClock,
    ids: UuidGenerator,
) -> tuple[LocalRecordingStorage, RegisterRecording]:
    storage = LocalRecordingStorage(config.roots)
    register = RegisterRecording(database, storage, WaveRecordingInspector(), clock, ids)
    return storage, register


def _startup_recovery(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    recordings: LocalRecordingStorage,
    register: RegisterRecording,
) -> RecoverySummary:
    transactions = RecoverTransactions(
        runtime.database,
        project.projects,
        project.songs,
        project.journal,
    )
    return StartupRecovery(
        processing.jobs,
        ReconcileRecordings(recordings, register),
        project.journal,
        transactions,
        ReconcileInterruptedSongs(runtime.database, runtime.clock),
    ).execute()


def _assemble_container(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    recognition_provider: SongRecognitionProvider | None,
    recording_storage: LocalRecordingStorage,
    register: RegisterRecording,
    lifecycle: BackendLifecycle,
    events: EventStream,
    instance_lock: BackendInstanceLock,
    executor: BoundedJobExecutor,
    recovery: RecoverySummary,
    settings: GetSettings,
) -> ApplicationContainer:
    recognition = _recognition(runtime, recognition_provider)
    songs = build_song_cases(runtime, project, processing, recognition)
    packages = build_package_cases(runtime, project, processing)
    recordings = build_recording_cases(runtime, project, processing, recording_storage, register)
    models = build_model_cases(runtime, processing, LocalModelStorage(runtime.config.roots))
    system = _system_cases(runtime, project, processing, lifecycle, executor, settings)
    processing.storage.cleanup_temp(max_age_seconds=24 * 60 * 60)
    set_ready_state(lifecycle, system.capabilities.execute())
    return ApplicationContainer(
        songs,
        packages,
        recordings,
        models,
        build_room_cases(runtime.ids, runtime.clock),
        system,
        lifecycle,
        events,
        runtime.database,
        instance_lock,
        executor,
        recovery,
    )


def _system_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    lifecycle: BackendLifecycle,
    executor: BoundedJobExecutor,
    settings: GetSettings,
) -> SystemCases:
    reconcile = ReconcileLibrary(
        runtime.database, project.projects, project.validator, project.songs, runtime.clock
    )
    system = build_system_cases(
        runtime, project, processing, lifecycle, executor, settings, reconcile
    )
    reconcile.execute()
    return system


def _recognition(
    runtime: RuntimeWiring, configured: SongRecognitionProvider | None
) -> SongRecognitionProvider:
    if configured:
        return configured
    video = YoutubeVideoFinder(runtime.config.youtube_api_key)
    catalog = ItunesCatalogRecognitionProvider(find_video=video)
    deezer = DeezerCatalogRecognitionProvider(find_video=video)
    shazam = ShazamRecognitionProvider(find_video=video)
    public_fallback = FallbackSongRecognitionProvider(
        shazam, FallbackSongRecognitionProvider(deezer, catalog)
    )
    if runtime.config.audd_api_token:
        return FallbackSongRecognitionProvider(
            AuddRecognitionProvider(runtime.config.audd_api_token, find_video=video),
            public_fallback,
        )
    return public_fallback
