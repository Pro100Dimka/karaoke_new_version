from __future__ import annotations

from dataclasses import replace
from collections.abc import Mapping

from backend.domain_errors import DomainError, NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording


class UpdateRecording:
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

    def room_result(self, recording_id: str, result: Mapping[str, object]) -> Recording:
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
            if recording is None:
                raise NotFoundError("RecordingNotFound", "Recording was not found")
            metadata = dict(recording.session_metadata or {})
            previous = metadata.get("roomPerformance")
            if not isinstance(previous, Mapping) or any(
                previous.get(key) != result.get(key) for key in ("roomId", "performanceId")
            ):
                raise DomainError(
                    "RoomPerformanceChanged", "Result belongs to a different take", 409
                )
            metadata["roomPerformance"] = dict(result)
            updated = replace(recording, session_metadata=metadata)
            transaction.recordings.update(updated)
            transaction.commit()
        return updated
