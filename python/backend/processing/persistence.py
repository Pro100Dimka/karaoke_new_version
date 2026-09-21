from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import ConflictError, DomainError, NotFoundError
from backend.history.domain import HistoryEvent
from backend.idempotency import IdempotencyRecord
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job
from backend.runtime import Clock, IdGenerator
from backend.songs.domain import Song, SongStatus


class ProcessingPersistence:
    """Owns processing-specific persistence and idempotency operations."""

    def __init__(self, uow: UnitOfWorkFactory, clock: Clock, ids: IdGenerator) -> None:
        self._uow = uow
        self._clock = clock
        self._ids = ids

    def load_song(self, song_id: str) -> Song:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
        if song is None:
            raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
        return song

    def set_status(self, song_id: str, status: SongStatus) -> None:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                raise NotFoundError("SongNotFound", "Song was not found", songId=song_id)
            transaction.songs.update(replace(song, status=status, updated_at=self._clock.now()))
            transaction.commit()

    def set_status_if_present(self, song_id: str, status: SongStatus) -> None:
        with self._uow.create() as transaction:
            song = transaction.songs.get(song_id)
            if song is None:
                return
            transaction.songs.update(replace(song, status=status, updated_at=self._clock.now()))
            transaction.commit()

    def record_started(self, song_id: str, *, kind: str | None = None) -> None:
        details = {"kind": kind} if kind else None
        now = self._clock.now()
        with self._uow.create() as transaction:
            transaction.history.add(
                HistoryEvent(
                    self._ids.new(),
                    "ProcessingStarted",
                    now,
                    "Song",
                    song_id,
                    details,
                )
            )
            transaction.commit()

    def repeated_job(
        self,
        operation: str,
        key: str | None,
        request_hash: str,
    ) -> Job | None:
        if not key:
            return None
        with self._uow.create() as transaction:
            record = transaction.idempotency.get(operation, key)
            job = transaction.jobs.get(record.response_json) if record else None
        if record is None:
            return None
        if record.request_hash != request_hash:
            raise ConflictError(
                "IdempotencyConflict",
                "Idempotency key was reused with different input",
            )
        if job is None:
            raise DomainError(
                "IdempotencyStateInvalid",
                "Stored processing job no longer exists",
                500,
            )
        return job

    def save_idempotency(
        self,
        operation: str,
        key: str | None,
        request_hash: str,
        job_id: str,
    ) -> None:
        if not key:
            return
        record = IdempotencyRecord(
            operation,
            key,
            request_hash,
            job_id,
            self._clock.now(),
        )
        with self._uow.create() as transaction:
            transaction.idempotency.add(record)
            transaction.commit()
