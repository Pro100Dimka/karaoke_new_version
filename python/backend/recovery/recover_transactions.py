from __future__ import annotations

from backend.persistence import UnitOfWorkFactory
from backend.projects.ports import ProjectStorage
from backend.recovery.domain import RecoveryEntry, RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.songs.ports import SongStorage


class RecoverTransactions:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        projects: ProjectStorage,
        songs: SongStorage,
        journal: RecoveryJournal,
    ) -> None:
        self._uow = uow
        self._projects = projects
        self._songs = songs
        self._journal = journal

    def execute(self) -> int:
        recovered = 0
        for entry in self._journal.entries():
            if self._recover(entry):
                self._journal.complete(entry.transaction_id)
                recovered += 1
        return recovered

    def _recover(self, entry: RecoveryEntry) -> bool:
        if entry.operation in {RecoveryOperation.PROJECT_PUBLISH, RecoveryOperation.PACKAGE_IMPORT}:
            return self._project_publication(entry)
        if entry.operation is RecoveryOperation.IMPORT_SONG:
            return self._song_import(entry)
        if entry.operation is RecoveryOperation.SONG_DELETE:
            return self._song_delete(entry)
        return False

    def _project_publication(self, entry: RecoveryEntry) -> bool:
        song_id = _text(entry, "songId")
        revision = _integer(entry, "revision")
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            revision_meta = transaction.projects.get(song_id, revision)
        committed = bool(song and song.active_revision == revision and revision_meta)
        if not committed and self._projects.revision_exists(song_id, revision):
            self._projects.remove_revision(song_id, revision)
        return True

    def _song_import(self, entry: RecoveryEntry) -> bool:
        song_id = _text(entry, "songId")
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            quarantine = self._songs.quarantine(song_id)
            if quarantine:
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
