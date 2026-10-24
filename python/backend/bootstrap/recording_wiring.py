from __future__ import annotations

from backend.analysis.queries import ListRecordingAnalyses
from backend.analysis.start_analysis import StartRecordingAnalysis
from backend.ai.provider_resolver import ResolveAiProvider
from backend.bootstrap.container import RecordingCases
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.infrastructure.recording_files import LocalRecordingStorage
from backend.infrastructure.wave_recording import WaveRecordingInspector
from backend.infrastructure.wave_pitch import VocalPitchExtractor
from backend.models.commands import EnsureRequiredModels
from backend.processing.preflight import ProcessingPreflight
from backend.recordings.allocate_target import AllocateRecordingTarget
from backend.recordings.delete_recording import DeleteRecording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.recordings.register_recording import RegisterRecording
from backend.recordings.start_studio_master import PublishStudioMaster, StartStudioMaster
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.update_recording import UpdateRecordingName
from backend.settings.queries import GetSettings


def build_recording_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    storage: LocalRecordingStorage,
    register: RegisterRecording,
) -> RecordingCases:
    analysis, studio_master = _analysis_and_mastering(
        runtime, project, processing, storage, register
    )
    return RecordingCases(
        AllocateRecordingTarget(storage, runtime.ids),
        register,
        GetRecording(runtime.database),
        ListRecordings(runtime.database),
        UpdateRecordingName(runtime.database),
        DeleteRecording(runtime.database, storage),
        analysis,
        ListRecordingAnalyses(runtime.database),
        studio_master,
    )


def _analysis_and_mastering(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    storage: LocalRecordingStorage,
    register: RegisterRecording,
) -> tuple[StartRecordingAnalysis, StartStudioMaster]:
    inspector = WaveRecordingInspector()
    publisher = PublishStudioMaster(storage, inspector, register, runtime.clock, runtime.ids)
    resolver = ResolveAiProvider(processing.registry, EnsureRequiredModels(runtime.database))
    resources = processing.resources
    settings = GetSettings(runtime.database)
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
    )
