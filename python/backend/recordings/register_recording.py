from __future__ import annotations

import hashlib
import threading
import logging
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Callable, Mapping, Sequence

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.idempotency import IdempotencyRecord
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording, validate_recording_id
from backend.recordings.ports import RecordingFileInspector, RecordingStorage
from backend.runtime import Clock, IdGenerator
from backend.processing.domain import JobType
from backend.processing.job_manager import ProcessingJobManager, JobContext


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
    display_name: str | None = None
    file_status: str = "Ready"
    allow_historical_revision: bool = False


class RegisterRecording:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        storage: RecordingStorage,
        inspector: RecordingFileInspector,
        clock: Clock,
        ids: IdGenerator,
        *,
        prepare_recording: Callable[[Recording, threading.Event], None] | None = None,
        jobs: ProcessingJobManager | None = None,
    ) -> None:
        self._uow = uow
        self._storage = storage
        self._inspector = inspector
        self._clock = clock
        self._ids = ids
        self._prepare_recording = prepare_recording
        self._jobs = jobs
        self._pending: set[str] = set()
        self._lock = threading.RLock()
        self._prepare_slot = threading.Semaphore(1)

    def execute(self, request: RegisterRecordingRequest) -> Recording:
        validate_recording_id(request.recording_id)
        existing = self._existing(request.recording_id)
        if existing:
            if existing.file_status not in {"Preparing", "PreparationFailed"}:
                self._storage.remove_recovery_descriptor(request.recording_id)
            return existing
        path = self._storage.validate_owned_file(request.file_path)
        metadata = self._inspector.inspect(path)
        self._validate_metadata(request, metadata.duration, metadata.sample_rate, metadata.channels)
        self._validate_song_revision(request)
        recording = Recording(
            request.recording_id, path, request.duration, request.sample_rate, request.channels,
            request.created_at, request.song_id, request.song_revision, tuple(request.gaps),
            request.session_metadata, request.display_name, request.file_status,
        )
        prepare = (request.file_status == "Ready" and self._prepare_recording is not None
                   and recording.song_id is not None
                   and not (recording.session_metadata or {}).get("studioMaster"))
        if prepare and self._jobs is not None:
            recording = replace(recording, file_status="Preparing")
        self._storage.write_recovery_descriptor(recording)
        if prepare and self._jobs is None and self._prepare_recording is not None:
            self._prepare_recording(recording, threading.Event())
        self._persist(recording, request.idempotency_key, _request_hash(request))
        if recording.file_status == "Preparing":
            self._schedule(recording)
        else:
            self._storage.remove_recovery_descriptor(recording.recording_id)
        return recording

    def resume_pending(self) -> None:
        offset = 0
        while True:
            with self._uow.create() as transaction:
                records = transaction.recordings.list(song_id=None, limit=200, offset=offset)
            for recording in records:
                if recording.file_status in {"Preparing", "PreparationFailed"}:
                    self._schedule(recording)
            if len(records) < 200:
                return
            offset += len(records)

    def retry(self, recording_id: str) -> Recording:
        recording = self._existing(recording_id)
        if recording is None:
            raise NotFoundError("RecordingNotFound", "Recording was not found")
        if recording.file_status in {"Preparing", "PreparationFailed"}:
            self._schedule(recording)
        return self._existing(recording_id) or recording

    def _schedule(self, recording: Recording) -> None:
        if self._jobs is None:
            return
        with self._lock:
            if recording.recording_id in self._pending:
                return
            self._pending.add(recording.recording_id)
            self._set_status(recording.recording_id, "Preparing")
            try:
                self._jobs.start(JobType.RECORDING_PREPARATION,
                                 lambda context: self._prepare(recording, context),
                                 entity_id=recording.recording_id,
                                 on_finally=lambda: self._release(recording.recording_id))
            except Exception:
                self._pending.discard(recording.recording_id)
                self._set_status(recording.recording_id, "PreparationFailed")
                logging.getLogger(__name__).exception("Recording preparation could not be queued")

    def _release(self, recording_id: str) -> None:
        with self._lock:
            self._pending.discard(recording_id)

    def _set_status(self, recording_id: str, status: str) -> None:
        with self._uow.create() as transaction:
            current = transaction.recordings.get(recording_id)
            if current is not None:
                transaction.recordings.update(replace(current, file_status=status))
                transaction.commit()

    def _prepare(self, recording: Recording, context: JobContext) -> dict[str, object]:
        acquired = False
        try:
            while not acquired:
                context.ensure_not_cancelled()
                acquired = self._prepare_slot.acquire(timeout=0.1)
            context.ensure_not_cancelled()
            if self._prepare_recording is not None:
                self._prepare_recording(recording, context.cancel)
            context.ensure_not_cancelled()
            self._set_status(recording.recording_id, "Ready")
            self._storage.remove_recovery_descriptor(recording.recording_id)
            return {"recordingId": recording.recording_id}
        except Exception:
            context.ensure_not_cancelled()
            self._set_status(recording.recording_id, "PreparationFailed")
            raise
        finally:
            if acquired:
                self._prepare_slot.release()

    def _existing(self, recording_id: str) -> Recording | None:
        with self._uow.create() as transaction:
            return transaction.recordings.get(recording_id)

    def _validate_song_revision(self, request: RegisterRecordingRequest) -> None:
        if request.song_id is None:
            return
        with self._uow.create() as transaction:
            song = transaction.songs.get(request.song_id)
            revision = (transaction.projects.get(request.song_id, request.song_revision)
                        if request.song_revision is not None else None)
        if song is None:
            raise NotFoundError("SongNotFound", "Recording references an unknown song")
        if request.song_revision is not None and request.song_revision != song.active_revision and (
            (request.file_status != "RecoveredIncomplete" and not request.allow_historical_revision)
            or revision is None
        ):
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
            request.display_name or "",
            request.file_status,
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
