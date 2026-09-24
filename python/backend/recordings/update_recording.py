from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording


class UpdateRecordingName:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, recording_id: str, display_name: str | None) -> Recording:
        normalized = display_name.strip() if display_name else None
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
            if recording is None:
                raise NotFoundError(
                    "RecordingNotFound", "Recording was not found", recordingId=recording_id
                )
            updated = replace(recording, display_name=normalized or None)
            transaction.recordings.update(updated)
            transaction.commit()
        return updated
