from __future__ import annotations

from functools import partial

from backend.analysis.queries import ListRecordingAnalyses
from backend.analysis.start_analysis import StartRecordingAnalysis
from backend.ai.provider_resolver import ResolveAiProvider
from backend.bootstrap.container import RecordingCases
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.infrastructure.recording_files import LocalRecordingStorage
from backend.infrastructure.recording_archive import RecordingArchive
from backend.infrastructure.wave_recording import WaveRecordingInspector
from backend.infrastructure.wave_pitch import VocalPitchExtractor
from backend.models.commands import EnsureRequiredModels
from backend.processing.preflight import ProcessingPreflight
from backend.recordings.allocate_target import allocate_recording_target
from backend.recordings.delete_recording import DeleteRecording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.recordings.register_recording import RegisterRecording
from backend.recordings.reconcile import ReconcileRecordings
from backend.recordings.start_studio_master import PublishStudioMaster, StartStudioMaster
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.update_recording import UpdateRecordingName
from backend.settings.queries import get_settings


def build_recording_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    storage: LocalRecordingStorage,
    register: RegisterRecording,
) -> RecordingCases:
    archive = RecordingArchive(
        runtime.config.roots.recordings, runtime.database, runtime.processes,
        ListRecordingAnalyses(runtime.database).execute, processing.jobs.run_when_idle,
    )
    analysis, studio_master = _analysis_and_mastering(
        runtime, project, processing, storage, register, archive
    )
    return RecordingCases(
        partial(allocate_recording_target, storage, runtime.ids),
        register,
        GetRecording(runtime.database),
        ListRecordings(runtime.database),
        UpdateRecordingName(runtime.database),
        DeleteRecording(runtime.database, storage),
        analysis,
        ListRecordingAnalyses(runtime.database),
        studio_master,
        ReconcileRecordings(storage, register),
        archive,
    )


def _analysis_and_mastering(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    storage: LocalRecordingStorage,
    register: RegisterRecording,
    archive: RecordingArchive,
) -> tuple[StartRecordingAnalysis, StartStudioMaster]:
    inspector = WaveRecordingInspector()
    publisher = PublishStudioMaster(storage, inspector, register, runtime.clock, runtime.ids)
    resolver = ResolveAiProvider(processing.registry, EnsureRequiredModels(runtime.database))
    resources = processing.resources
    settings = partial(get_settings, runtime.database)
    analysis = StartRecordingAnalysis(
        runtime.database,
        processing.jobs,
        project.projects,
        VocalPitchExtractor(
            ProcessingPreflight(resolver), settings, resources, processing.workspaces
        ),
        runtime.hasher,
        runtime.clock,
        runtime.ids,
        archive.request,
    )
    return analysis, StartStudioMaster(
        runtime.database,
        processing.jobs,
        project.projects,
        resolver,
        settings,
        resources,
        processing.workspaces,
        FfmpegStudioMasterRenderer(runtime.processes),
        publisher,
        archive.request,
    )
