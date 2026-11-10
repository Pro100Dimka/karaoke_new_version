from __future__ import annotations

from pathlib import Path

from backend.persistence import UnitOfWorkFactory
from backend.projects.ports import ProjectStorage
from backend.recovery.domain import RecoveryEntry, RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.recordings.ports import RecordingStorage
from backend.songs.ports import SongStorage


class RecoverTransactions:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        projects: ProjectStorage,
        songs: SongStorage,
        journal: RecoveryJournal,
        recordings: RecordingStorage,
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._songs = songs
        self._journal = journal
        self._recordings = recordings

    def execute(self) -> int:
        recovered = 0
        for entry in self._journal.entries():
            if self._recover(entry):
                self._journal.complete(entry.transaction_id)
                recovered += 1
        return recovered

    def _recover(self, entry: RecoveryEntry) -> bool:
        handlers = {
            RecoveryOperation.PROJECT_PUBLISH: self._project_publication,
            RecoveryOperation.PACKAGE_IMPORT: self._project_publication,
            RecoveryOperation.IMPORT_SONG: self._song_import,
            RecoveryOperation.SONG_DELETE: self._song_delete,
            RecoveryOperation.RECORDING_REGISTER: self._recording_import,
            RecoveryOperation.RECORDING_DELETE: self._recording_delete,
        }
        handler = handlers.get(entry.operation)
        return handler(entry) if handler else False

    def _recording_delete(self, entry: RecoveryEntry) -> bool:
        recording_id = _text(entry, "recordingId")
        path = Path(_text(entry, "filePath"))
        quarantine = self._recordings.quarantine_path(recording_id, path)
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if quarantine.parent.exists():
            if recording is None:
                self._recordings.finalize_quarantine(quarantine)
            else:
                self._recordings.restore_quarantine(quarantine, path)
        return True

    def _project_publication(self, entry: RecoveryEntry) -> bool:
        song_id = _text(entry, "songId")
        revision = _integer(entry, "revision")
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            revision_meta = transaction.projects.get(song_id, revision)
        committed = bool(song and revision_meta)
        if not committed and self._projects.revision_exists(song_id, revision):
            self._projects.remove_revision(song_id, revision)
        return True

    def _song_import(self, entry: RecoveryEntry) -> bool:
        song_id = _text(entry, "songId")
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            quarantine = self._songs.quarantine(song_id) or self._songs.quarantine_path(song_id)
            if quarantine.exists():
                self._songs.finalize_quarantine(quarantine)
        return True

    def _song_delete(self, entry: RecoveryEntry) -> bool:
        song_id = _text(entry, "songId")
        quarantine = self._songs.quarantine_path(song_id)
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            if quarantine.exists():
                self._songs.finalize_quarantine(quarantine)
        elif quarantine.exists():
            self._songs.restore_quarantine(song_id, quarantine)
        recordings = entry.data.get("recordings", [])
        if not isinstance(recordings, list):
            raise ValueError("Recovery recordings must be a list")
        for item in recordings:
            if not isinstance(item, dict):
                raise ValueError("Invalid recording recovery entry")
            recording_id, file_path = item.get("recordingId"), item.get("filePath")
            if not isinstance(recording_id, str) or not isinstance(file_path, str):
                raise ValueError("Invalid recording recovery path")
            path = Path(file_path)
            pending = self._recordings.quarantine_path(recording_id, path)
            if pending.parent.exists():
                if song is None:
                    self._recordings.finalize_quarantine(pending)
                else:
                    self._recordings.restore_quarantine(pending, path)
        return True

    def _recording_import(self, entry: RecoveryEntry) -> bool:
        recording_id = _text(entry, "recordingId")
        path = Path(_text(entry, "filePath"))
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if recording is None:
            quarantine = self._recordings.quarantine_path(recording_id, path)
            if path.exists():
                quarantine = self._recordings.quarantine(recording_id, path)
            if quarantine.parent.exists():
                self._recordings.finalize_quarantine(quarantine)
        return True


def _text(entry: RecoveryEntry, key: str) -> str:
    value = entry.data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"Recovery field {key} must be text")
    return value


def _integer(entry: RecoveryEntry, key: str) -> int:
    value = entry.data.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"Recovery field {key} must be integer")
    return value
