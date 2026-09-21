from __future__ import annotations

from backend.analysis.queries import GetAnalysis, ListRecordingAnalyses
from backend.analysis.start_analysis import StartRecordingAnalysis
from backend.bootstrap.container import RecordingCases
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.infrastructure.recording_files import LocalRecordingStorage
from backend.infrastructure.wave_pitch import WavePitchExtractor
from backend.recordings.allocate_target import AllocateRecordingTarget
from backend.recordings.delete_recording import DeleteRecording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.recordings.register_recording import RegisterRecording


def build_recording_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    storage: LocalRecordingStorage,
    register: RegisterRecording,
) -> RecordingCases:
    analysis = StartRecordingAnalysis(
        runtime.database,
        processing.jobs,
        project.projects,
        WavePitchExtractor(),
        runtime.hasher,
        runtime.clock,
        runtime.ids,
    )
    return RecordingCases(
        AllocateRecordingTarget(storage, runtime.ids),
        register,
        GetRecording(runtime.database),
        ListRecordings(runtime.database),
        DeleteRecording(runtime.database, storage),
        analysis,
        GetAnalysis(runtime.database),
        ListRecordingAnalyses(runtime.database),
    )
