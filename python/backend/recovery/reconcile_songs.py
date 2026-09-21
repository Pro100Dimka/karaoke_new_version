from __future__ import annotations

from dataclasses import replace

from backend.persistence import UnitOfWorkFactory
from backend.runtime import Clock
from backend.songs.domain import SongStatus

_UNFINISHED = (SongStatus.QUEUED, SongStatus.PROCESSING, SongStatus.CANCELLING)
_BATCH = 500


class ReconcileInterruptedSongs:
    """At startup no processing job is alive, so a song still marked Queued/Processing lost its job to a crash.

    Such songs become Failed so the user can retry instead of finding them stuck forever.
    """

    def __init__(self, uow: UnitOfWorkFactory, clock: Clock) -> None:
        self._uow = uow
        self._clock = clock

    def execute(self) -> int:
        repaired = 0
        with self._uow.create() as transaction:
            for status in _UNFINISHED:
                songs = transaction.songs.list(
                    search=None,
                    status=status,
                    sort="createdAt",
                    descending=False,
                    limit=_BATCH,
                    offset=0,
                )
                for song in songs:
                    transaction.songs.update(
                        replace(song, status=SongStatus.FAILED, updated_at=self._clock.now())
                    )
                    repaired += 1
            transaction.commit()
        return repaired
