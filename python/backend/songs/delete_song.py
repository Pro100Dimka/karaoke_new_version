from __future__ import annotations

from backend.domain_errors import DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.runtime import Clock
from backend.runtime import IdGenerator
from backend.projects.operations import SongOperation, SongOperationRegistry
from backend.persistence import UnitOfWorkFactory
from backend.recovery.domain import RecoveryOperation
from backend.recovery.ports import RecoveryJournal
from backend.songs.ports import SongStorage


class DeleteSong:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        storage: SongStorage,
        operations: SongOperationRegistry,
        journal: RecoveryJournal,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._storage = storage
        self._operations = operations
        self._journal = journal
        self._clock = clock
        self._ids = ids

    def execute(self, song_id: str) -> None:
        with self._operations.acquire(song_id, SongOperation.DELETE):
            self._delete(song_id)

    def _delete(self, song_id: str) -> None:
        with self._uow.create() as transaction:
            if transaction.songs.get(song_id) is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        quarantine = self._storage.quarantine(song_id)
        entry = self._journal.begin(
            RecoveryOperation.SONG_DELETE,
            {"songId": song_id, "quarantine": str(quarantine) if quarantine else ""},
        )
        try:
            self._delete_metadata(song_id)
        except DomainError:
            if quarantine:
                self._storage.restore_quarantine(song_id, quarantine)
            self._journal.complete(entry.transaction_id)
            raise
        if quarantine:
            self._storage.finalize_quarantine(quarantine)
        self._journal.complete(entry.transaction_id)

    def _delete_metadata(self, song_id: str) -> None:
        now = self._clock.now()
        event = HistoryEvent(self._ids.new(), "SongDeleted", now, "Song", song_id)
        with self._uow.create() as transaction:
            transaction.songs.delete(song_id)
            transaction.history.add(event)
            transaction.commit()
