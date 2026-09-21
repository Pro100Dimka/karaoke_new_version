from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from backend.domain_errors import NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording


@dataclass(frozen=True, slots=True)
class RecordingPage:
    items: Sequence[Recording]
    total: int
    limit: int
    offset: int


class GetRecording:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, recording_id: str) -> Recording:
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if recording is None:
            raise NotFoundError(
                "RecordingNotFound", "Recording was not found", recordingId=recording_id
            )
        return recording


class ListRecordings:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, *, song_id: str | None, limit: int, offset: int) -> RecordingPage:
        with self._uow.create() as transaction:
            items = transaction.recordings.list(song_id=song_id, limit=limit, offset=offset)
            total = transaction.recordings.count(song_id=song_id)
        return RecordingPage(items, total, limit, offset)
