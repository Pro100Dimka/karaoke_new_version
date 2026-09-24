from __future__ import annotations

from dataclasses import dataclass

from backend.analysis.queries import GetAnalysis, ListRecordingAnalyses
from backend.analysis.start_analysis import StartRecordingAnalysis
from backend.bootstrap.lifecycle import BackendLifecycle
from backend.bootstrap.room_wiring import RoomCases
from backend.capabilities.query import GetCapabilities
from backend.diagnostics.query import GetDiagnostics
from backend.editor.get_document import GetEditorDocument
from backend.editor.reset_document import ResetEditorDocument
from backend.editor.save_document import SaveEditorDocument
from backend.history.queries import ListHistory
from backend.infrastructure.database import Database
from backend.infrastructure.event_stream import EventStream
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.job_executor import BoundedJobExecutor
from backend.models.commands import DeclareModel, DownloadModel, SelectModel
from backend.models.queries import ListModels
from backend.packages.background import StartPackageExport, StartPackageImport
from backend.packages.inspect_package import InspectPackage
from backend.processing.cancel_processing import CancelProcessing
from backend.processing.job_manager import ProcessingJobManager
from backend.processing.reprocess_melody import ReprocessMelody
from backend.processing.start_processing import StartProcessing
from backend.projects.migration import GetProjectCompatibility, MigrateProject
from backend.recordings.allocate_target import AllocateRecordingTarget
from backend.recordings.delete_recording import DeleteRecording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.recordings.register_recording import RegisterRecording
from backend.recordings.update_recording import UpdateRecordingName
from backend.recovery.background import StartLibraryReconciliation
from backend.recovery.startup_recovery import RecoverySummary
from backend.settings.queries import GetSettings
from backend.settings.update_settings import UpdateSettings
from backend.songs.delete_song import DeleteSong
from backend.songs.import_song import ImportSong
from backend.songs.start_import import StartSongImport
from backend.songs.queries import GetSong, ListSongs
from backend.songs.update_song import UpdateSong
from backend.storage.cleanup import ClearProcessingCache, RemoveTemporaryFiles
from backend.storage.domain import StorageRoots


@dataclass(frozen=True, slots=True)
class SongCases:
    import_song: ImportSong
    start_import: StartSongImport
    get_song: GetSong
    list_songs: ListSongs
    update_song: UpdateSong
    delete_song: DeleteSong
    start_processing: StartProcessing
    reprocess_melody: ReprocessMelody
    cancel_processing: CancelProcessing
    get_editor: GetEditorDocument
    save_editor: SaveEditorDocument
    reset_editor: ResetEditorDocument
    compatibility: GetProjectCompatibility
    migrate_project: MigrateProject


@dataclass(frozen=True, slots=True)
class PackageCases:
    inspect: InspectPackage
    start_export: StartPackageExport
    start_import: StartPackageImport


@dataclass(frozen=True, slots=True)
class RecordingCases:
    allocate: AllocateRecordingTarget
    register: RegisterRecording
    get: GetRecording
    list: ListRecordings
    update_name: UpdateRecordingName
    delete: DeleteRecording
    start_analysis: StartRecordingAnalysis
    get_analysis: GetAnalysis
    list_analyses: ListRecordingAnalyses


@dataclass(frozen=True, slots=True)
class ModelCases:
    declare: DeclareModel
    select: SelectModel
    list: ListModels
    download: DownloadModel


@dataclass(frozen=True, slots=True)
class SystemCases:
    capabilities: GetCapabilities
    diagnostics: GetDiagnostics
    settings: GetSettings
    update_settings: UpdateSettings
    history: ListHistory
    jobs: ProcessingJobManager
    reconcile: StartLibraryReconciliation
    clear_cache: ClearProcessingCache
    remove_temp: RemoveTemporaryFiles


@dataclass(slots=True)
class ApplicationContainer:
    songs: SongCases
    packages: PackageCases
    recordings: RecordingCases
    models: ModelCases
    rooms: RoomCases
    system: SystemCases
    lifecycle: BackendLifecycle
    events: EventStream
    database: Database
    instance_lock: BackendInstanceLock
    executor: BoundedJobExecutor
    startup_recovery: RecoverySummary
    roots: StorageRoots

    def shutdown(self) -> None:
        self.lifecycle.stopping()
        self.executor.stop_accepting()
        try:
            self.executor.shutdown()
        finally:
            try:
                self.database.dispose()
            finally:
                self.instance_lock.release()
