from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Mapping, Sequence

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.idempotency import IdempotencyRecord
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording
from backend.recordings.ports import RecordingFileInspector, RecordingStorage
from backend.runtime import Clock, IdGenerator


@dataclass(frozen=True, slots=True)
class RegisterRecordingRequest:
    recording_id: str
    file_path: Path
    duration: float
    sample_rate: int
    channels: int
    created_at: datetime
    song_id: str | None = None
    song_revision: int | None = None
    gaps: Sequence[Mapping[str, float]] = ()
    session_metadata: Mapping[str, object] | None = None
    idempotency_key: str | None = None


class RegisterRecording:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        storage: RecordingStorage,
        inspector: RecordingFileInspector,
        clock: Clock,
        ids: IdGenerator,
    ) -> None:
        self._uow = uow
        self._storage = storage
        self._inspector = inspector
        self._clock = clock
        self._ids = ids

    def execute(self, request: RegisterRecordingRequest) -> Recording:
        existing = self._existing(request.recording_id)
        if existing:
            return existing
        path = self._storage.validate_owned_file(request.file_path)
        metadata = self._inspector.inspect(path)
        self._validate_metadata(request, metadata.duration, metadata.sample_rate, metadata.channels)
        self._validate_song_revision(request)
        recording = Recording(
            request.recording_id,
            path,
            request.duration,
            request.sample_rate,
            request.channels,
            request.created_at,
            request.song_id,
            request.song_revision,
            tuple(request.gaps),
            request.session_metadata,
        )
        self._persist(recording, request.idempotency_key, _request_hash(request))
        self._storage.remove_recovery_descriptor(recording.recording_id)
        return recording

    def _existing(self, recording_id: str) -> Recording | None:
        with self._uow.create() as transaction:
            return transaction.recordings.get(recording_id)

    def _validate_song_revision(self, request: RegisterRecordingRequest) -> None:
        if request.song_id is None:
            return
        with self._uow.create() as transaction:
            song = transaction.songs.get(request.song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Recording references an unknown song")
        if request.song_revision is not None and request.song_revision != song.active_revision:
            raise ConflictError(
                "RevisionConflict", "Recording references a non-active song revision"
            )

    @staticmethod
    def _validate_metadata(
        request: RegisterRecordingRequest, duration: float, rate: int, channels: int
    ) -> None:
        tolerance = max(0.05, request.duration * 0.01)
        if abs(duration - request.duration) > tolerance:
            raise DomainError(
                "InvalidRecording", "Recording duration does not match finalized file", 400
            )
        if rate != request.sample_rate or channels != request.channels:
            raise DomainError(
                "InvalidRecording", "Recording stream metadata does not match finalized file", 400
            )

    def _persist(self, recording: Recording, key: str | None, request_hash: str) -> None:
        with self._uow.create() as transaction:
            transaction.recordings.add(recording)
            transaction.history.add(
                HistoryEvent(
                    self._ids.new(),
                    "RecordingRegistered",
                    self._clock.now(),
                    "Recording",
                    recording.recording_id,
                )
            )
            if key:
                transaction.idempotency.add(
                    IdempotencyRecord(
                        "RegisterRecording",
                        key,
                        request_hash,
                        recording.recording_id,
                        self._clock.now(),
                    )
                )
            transaction.commit()


def _request_hash(request: RegisterRecordingRequest) -> str:
    raw = "\0".join(
        [
            request.recording_id,
            str(request.file_path),
            f"{request.duration:.9f}",
            str(request.sample_rate),
            str(request.channels),
            request.song_id or "",
            str(request.song_revision or ""),
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
