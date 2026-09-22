from __future__ import annotations

from backend.ai.provider_resolver import ResolveAiProvider
from backend.bootstrap.container import SongCases
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.editor.get_document import GetEditorDocument
from backend.editor.reset_document import ResetEditorDocument
from backend.editor.save_document import SaveEditorDocument
from backend.infrastructure.clock import SystemMonotonicClock
from backend.infrastructure.ffmpeg_audio import FfmpegAudioNormalizer, FfmpegAudioValidator
from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.job_executor import ThreadConcurrentRunner
from backend.infrastructure.processing_cache import LocalProcessingCache
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.infrastructure.wave_music_analyzer import WaveMusicAnalyzer
from backend.infrastructure.youtube_clip import YoutubeClipDownloader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.models.commands import EnsureRequiredModels
from backend.processing.ai_stages import AlignmentStage, LyricsStage, PitchStage, SeparationStage
from backend.processing.audio_pipeline import PrepareProcessingAudio
from backend.processing.cancel_processing import CancelProcessing
from backend.processing.document_pipeline import BuildProcessingDocument
from backend.processing.melody_pipeline import MelodyPipeline
from backend.processing.normalize_stage import NormalizeStage
from backend.processing.orchestrator import PipelineOrchestrator
from backend.processing.persistence import ProcessingPersistence
from backend.processing.preflight import ProcessingPreflight
from backend.processing.reference_stage import PrepareReferenceVocal
from backend.processing.reprocess_melody import ReprocessMelody
from backend.processing.resource_scheduler import ProcessingResourceScheduler
from backend.processing.stage_runner import StageRunner
from backend.processing.start_processing import StartProcessing
from backend.projects.migration import GetProjectCompatibility, MigrateProject
from backend.projects.publisher import ProjectPublisher
from backend.settings.queries import GetSettings
from backend.songs.delete_song import DeleteSong
from backend.songs.import_song import ImportSong
from backend.songs.queries import GetSong, ListSongs
from backend.songs.update_song import UpdateSong
from backend.songs.recognition import SongRecognitionProvider
from backend.songs.refresh_recognition import RefreshSongRecognition
from backend.songs.prepare_clip import PrepareSong, PrepareSongClip


def build_song_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    recognition: SongRecognitionProvider,
) -> SongCases:
    start, melody = _build_processing(runtime, project, processing, recognition)
    save_editor = _save_editor(runtime, project)
    return SongCases(
        _import_song(runtime, project, recognition),
        GetSong(runtime.database),
        ListSongs(runtime.database, runtime.config.api.max_page_limit),
        UpdateSong(runtime.database, project.songs, runtime.clock),
        DeleteSong(
            runtime.database,
            project.songs,
            project.operations,
            project.journal,
            runtime.clock,
            runtime.ids,
        ),
        start,
        melody,
        CancelProcessing(runtime.database, processing.jobs, runtime.clock),
        GetEditorDocument(runtime.database, project.projects),
        save_editor,
        ResetEditorDocument(project.projects, save_editor),
        GetProjectCompatibility(project.projects),
        _project_migration(runtime, project),
    )


def _import_song(
    runtime: RuntimeWiring, project: ProjectWiring, recognition: SongRecognitionProvider
) -> ImportSong:
    return ImportSong(
        runtime.database,
        project.songs,
        project.projects,
        FfmpegMediaInspector(runtime.processes),
        runtime.hasher,
        project.journal,
        runtime.clock,
        runtime.ids,
        recognition,
    )


def _save_editor(runtime: RuntimeWiring, project: ProjectWiring) -> SaveEditorDocument:
    return SaveEditorDocument(
        runtime.database,
        project.projects,
        project.validator,
        project.operations,
        project.locks,
        project.journal,
        runtime.clock,
        runtime.ids,
    )


def _project_migration(runtime: RuntimeWiring, project: ProjectWiring) -> MigrateProject:
    return MigrateProject(
        runtime.database,
        project.projects,
        project.validator,
        project.operations,
        project.locks,
        project.journal,
        runtime.config.roots.app / "backups",
        runtime.clock,
        runtime.ids,
    )


def _build_processing(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    recognition: SongRecognitionProvider,
) -> tuple[StartProcessing, ReprocessMelody]:
    resolver = ResolveAiProvider(processing.registry, EnsureRequiredModels(runtime.database))
    resources = ProcessingResourceScheduler(
        processing.runtime,
        processing.storage,
        runtime.config.roots.temp,
        runtime.config.resources,
    )
    runner = StageRunner(SystemMonotonicClock())
    publisher = _project_publisher(runtime, project)
    pipeline = _processing_pipeline(runtime, processing, publisher, runner)
    persistence = ProcessingPersistence(runtime.database, runtime.clock, runtime.ids)
    start = StartProcessing(
        processing.jobs,
        pipeline,
        GetSettings(runtime.database),
        ProcessingPreflight(resolver),
        project.songs,
        resources,
        project.operations,
        persistence,
        _song_preparation(runtime, recognition),
    )
    melody = ReprocessMelody(
        processing.jobs,
        GetSettings(runtime.database),
        resolver,
        resources,
        MelodyPipeline(project.projects, project.validator, publisher, runner, runtime.ids),
        project.operations,
        persistence,
    )
    return start, melody


def _song_preparation(runtime: RuntimeWiring, recognition: SongRecognitionProvider) -> PrepareSong:
    refresh = RefreshSongRecognition(runtime.database, recognition, runtime.clock)
    clip = PrepareSongClip(
        runtime.database,
        YoutubeClipDownloader(processes=runtime.processes),
        runtime.clock,
    )
    return PrepareSong(refresh, clip)


def _project_publisher(runtime: RuntimeWiring, project: ProjectWiring) -> ProjectPublisher:
    return ProjectPublisher(
        runtime.database,
        project.projects,
        project.validator,
        runtime.hasher,
        project.journal,
        project.locks,
        runtime.clock,
        runtime.ids,
    )


def _processing_pipeline(
    runtime: RuntimeWiring,
    processing: ProcessingWiring,
    publisher: ProjectPublisher,
    runner: StageRunner,
) -> PipelineOrchestrator:
    normalize = NormalizeStage(
        FfmpegAudioNormalizer(runtime.processes),
        LocalProcessingCache(runtime.config.roots.cache),
        cpu_threads=runtime.config.resources.cpu_threads,
    )
    discovery = LyricsDiscovery(
        LocalSidecarLyricsReader(),
        processing.lyrics_providers,
        LyricsMatchPolicy(),
    )
    audio = PrepareProcessingAudio(
        normalize,
        WaveMusicAnalyzer(),
        SeparationStage(),
        PrepareReferenceVocal(FfmpegAudioValidator(runtime.processes)),
        runner,
    )
    document = BuildProcessingDocument(
        LyricsStage(discovery), AlignmentStage(), PitchStage(), runner, ThreadConcurrentRunner()
    )
    return PipelineOrchestrator(
        audio, document, publisher, processing.workspaces, runner, runtime.ids
    )
