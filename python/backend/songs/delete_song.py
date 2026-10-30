from __future__ import annotations

from pathlib import Path

from backend.domain_errors import ConflictError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.runtime import Clock
from backend.runtime import IdGenerator
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.persistence import UnitOfWorkFactory
from backend.recovery.domain import RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.songs.ports import SongStorage
from backend.recordings.ports import RecordingStorage
from backend.processing.job_manager import ProcessingJobManager


class DeleteSong:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        storage: SongStorage,
        operations: SongOperationRegistry,
        journal: RecoveryJournal,
        clock: Clock,
        ids: IdGenerator,
        recordings: RecordingStorage,
        jobs: ProcessingJobManager,
    ) -> None:
        self._uow = uow
        self._storage = storage
        self._operations = operations
        self._journal = journal
        self._clock = clock
        self._ids = ids
        self._recordings = recordings
        self._jobs = jobs

    def execute(self, song_id: str) -> None:
        with self._operations.acquire(song_id, SongOperation.DELETE):
            self._jobs.run_when_idle(
                lambda: self._delete(song_id),
                busy_error=ConflictError("LibraryInUse", "Wait for background jobs to finish before deleting songs"),
            )

    def _delete(self, song_id: str) -> None:
        recordings = self._recordings_for_song(song_id)
        entry = self._journal.begin(
            RecoveryOperation.SONG_DELETE,
            {"songId": song_id, "recordings": [
                {"recordingId": recording_id, "filePath": str(path)}
                for recording_id, path in recordings.items()
            ]},
        )
        quarantine = None
        moved: list[tuple[Path, Path]] = []
        completed = False
        try:
            for recording_id, path in recordings.items():
                if path.parent.exists():
                    moved.append((self._recordings.quarantine(recording_id, path), path))
            quarantine = self._storage.quarantine(song_id)
            self._delete_metadata(song_id)
            completed = True
        finally:
            if not completed:
                if quarantine:
                    self._storage.restore_quarantine(song_id, quarantine)
                for source, target in reversed(moved):
                    self._recordings.restore_quarantine(source, target)
                self._journal.complete(entry.transaction_id)
        for source, _ in moved:
            self._recordings.finalize_quarantine(source)
        if quarantine:
            self._storage.finalize_quarantine(quarantine)
        self._journal.complete(entry.transaction_id)

    def _recordings_for_song(self, song_id: str) -> dict[str, Path]:
        with self._uow.create() as transaction:
            if transaction.songs.get(song_id) is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            recordings = {
                recording.recording_id: recording.file_path
                for recording in transaction.recordings.list(
                    song_id=song_id, limit=transaction.recordings.count(song_id=song_id), offset=0,
                )
            }
        for descriptor in self._recordings.recovery_descriptors():
            data = self._recordings.read_recovery_descriptor(descriptor)
            if data.get("songId") == song_id:
                recording_id, file_path = data.get("recordingId"), data.get("filePath")
                if isinstance(recording_id, str) and isinstance(file_path, str):
                    recordings[recording_id] = Path(file_path)
        return recordings

    def _delete_metadata(self, song_id: str) -> None:
        now = self._clock.now()
        event = HistoryEvent(self._ids.new(), "SongDeleted", now, "Song", song_id)
        with self._uow.create() as transaction:
            transaction.songs.delete(song_id)
            transaction.history.add(event)
            transaction.commit()
