from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from backend.analysis.queries import ListRecordingAnalyses
from backend.analysis.start_analysis import StartRecordingAnalysis
from backend.bootstrap.lifecycle import BackendLifecycle
from backend.bootstrap.room_wiring import RoomCases
from backend.capabilities.query import GetCapabilities
from backend.diagnostics.query import GetDiagnostics
from backend.editor.get_document import GetEditorDocument
from backend.editor.reset_document import ResetEditorDocument
from backend.editor.save_document import SaveEditorDocument
from backend.history.queries import ListHistory
from backend.infrastructure.artwork_cache import ArtworkCache
from backend.infrastructure.database import Database
from backend.infrastructure.event_stream import EventStream
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.job_executor import BoundedJobExecutor
from backend.models.commands import DeclareModel, DeleteModel, DownloadModel, SelectModel
from backend.packages.background import StartPackageExport, StartPackageImport
from backend.packages.inspect_package import InspectPackage
from backend.packages.library_archive import LibraryArchive
from backend.processing.cancel_processing import CancelProcessing
from backend.processing.job_manager import ProcessingJobManager
from backend.processing.reprocess_melody import ReprocessMelody
from backend.processing.start_processing import StartProcessing
from backend.projects.migration import GetProjectCompatibility, MigrateProject
from backend.recordings.allocate_target import RecordingTarget
from backend.recordings.delete_recording import DeleteRecording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.recordings.register_recording import RegisterRecording
from backend.recordings.update_recording import UpdateRecordingName
from backend.recordings.start_studio_master import StartStudioMaster
from backend.recovery.background import StartLibraryReconciliation
from backend.recovery.startup_recovery import RecoverySummary
from backend.settings.queries import SettingsReader
from backend.settings.update_settings import UpdateSettings
from backend.songs.delete_song import DeleteSong
from backend.songs.import_song import ImportSong
from backend.songs.start_import import StartSongImport
from backend.songs.queries import GetSong, GetSongWaveform, ListSongs
from backend.songs.update_song import UpdateSong
from backend.storage.domain import StorageRoots


@dataclass(frozen=True, slots=True)
class SongCases:
    import_song: ImportSong
    start_import: StartSongImport
    get_song: GetSong
    get_waveform: GetSongWaveform
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
    library: LibraryArchive


@dataclass(frozen=True, slots=True)
class RecordingCases:
    allocate: Callable[[], RecordingTarget]
    register: RegisterRecording
    get: GetRecording
    list: ListRecordings
    update_name: UpdateRecordingName
    delete: DeleteRecording
    start_analysis: StartRecordingAnalysis
    list_analyses: ListRecordingAnalyses
    start_studio_master: StartStudioMaster


@dataclass(frozen=True, slots=True)
class ModelCases:
    declare: DeclareModel
    select: SelectModel
    download: DownloadModel
    delete: DeleteModel


@dataclass(frozen=True, slots=True)
class SystemCases:
    capabilities: GetCapabilities
    diagnostics: GetDiagnostics
    settings: SettingsReader
    update_settings: UpdateSettings
    history: ListHistory
    jobs: ProcessingJobManager
    reconcile: StartLibraryReconciliation
    clear_cache: Callable[[], int]
    remove_temp: Callable[[], int]
    free_storage_bytes: Callable[[str], int]


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
    artwork: ArtworkCache

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
