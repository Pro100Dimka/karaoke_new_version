from __future__ import annotations

from backend.domain_errors import NotFoundError
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording
from backend.recordings.ports import RecordingStorage


class DeleteRecording:
    def __init__(self, uow: UnitOfWorkFactory, storage: RecordingStorage) -> None:
        self._uow = uow
        self._storage = storage

    def execute(self, recording_id: str) -> None:
        recording = self._load(recording_id)
        quarantine = self._storage.quarantine(recording_id, recording.file_path)
        committed = False
        try:
            with self._uow.create() as transaction:
                transaction.recordings.delete(recording_id)
                transaction.commit()
            committed = True
        finally:
            if not committed:
                self._storage.restore_quarantine(quarantine, recording.file_path)
        self._storage.finalize_quarantine(quarantine)

    def _load(self, recording_id: str) -> Recording:
        with self._uow.create() as transaction:
            recording = transaction.recordings.get(recording_id)
        if recording is None:
            raise NotFoundError("RecordingNotFound", "Recording was not found")
        return recording
