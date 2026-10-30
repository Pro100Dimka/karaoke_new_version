from __future__ import annotations

import sqlite3
import logging
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager, closing, nullcontext
from pathlib import Path
from types import TracebackType
from uuid import uuid4

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from backend.domain_errors import DependencyError
from backend.events import EventPublisher
from backend.infrastructure.sql_analysis import SqlAnalysisRepository
from backend.infrastructure.sql_history import SqlHistoryRepository
from backend.infrastructure.sql_idempotency import SqlIdempotencyRepository
from backend.infrastructure.sql_jobs import SqlJobRepository
from backend.infrastructure.sql_models import SqlModelRepository
from backend.infrastructure.sql_projects import SqlProjectRevisionRepository
from backend.infrastructure.sql_recordings import SqlRecordingRepository
from backend.infrastructure.sql_settings import SqlSettingsRepository
from backend.infrastructure.sql_songs import SqlSongRepository
from backend.persistence import UnitOfWork

logger = logging.getLogger(__name__)


class Database:
    def __init__(self, path: Path, events: EventPublisher | None = None) -> None:
        self.path = path
        self._events = events
        self._catalog_lock = threading.RLock()
        self._catalog_revision = uuid4().hex
        self._played_revision = self._catalog_revision
        self._engine = create_engine(
            f"sqlite:///{path}",
            connect_args={"check_same_thread": False},
            future=True,
        )
        event.listen(self._engine, "connect", _configure_sqlite)
        self._sessions = sessionmaker(bind=self._engine, expire_on_commit=False, autoflush=False)

    @property
    def engine(self) -> Engine:
        return self._engine

    def create(self) -> "SqlUnitOfWork":
        return SqlUnitOfWork(
            self._sessions(),
            self._publish,
            lambda played: self._played_revision if played else self._catalog_revision,
            self._catalog_lock,
        )

    def _publish(self, changes: dict[str, list[str]]) -> None:
        if changes["songIds"] or changes["deletedIds"]:
            self._catalog_revision = uuid4().hex
        self._played_revision = uuid4().hex
        if self._events:
            self._events.publish("library.changed", changes)

    def validate(self) -> None:
        try:
            with closing(sqlite3.connect(self.path)) as connection:
                result = connection.execute("PRAGMA quick_check").fetchone()
        except sqlite3.DatabaseError as exc:
            raise DependencyError(
                "DatabaseUnavailable", "SQLite database cannot be opened"
            ) from exc
        if not result or result[0] != "ok":
            raise DependencyError("DatabaseCorrupt", "SQLite integrity check failed")

    def dispose(self) -> None:
        self._engine.dispose()


class SqlUnitOfWork(UnitOfWork):
    def __init__(
        self,
        session: Session,
        notify: Callable[[dict[str, list[str]]], None] | None = None,
        revision: Callable[[bool], str] | None = None,
        lock: AbstractContextManager[object] | None = None,
    ) -> None:
        self._session = session
        self._notify = notify
        self._catalog_lock = lock or nullcontext()
        self.songs = SqlSongRepository(session, revision, self._catalog_lock)
        self.projects = SqlProjectRevisionRepository(session)
        self.jobs = SqlJobRepository(session)
        self.recordings = SqlRecordingRepository(session)
        self.analyses = SqlAnalysisRepository(session)
        self.models = SqlModelRepository(session)
        self.history = SqlHistoryRepository(session)
        self.settings = SqlSettingsRepository(session)
        self.idempotency = SqlIdempotencyRepository(session)

    def __enter__(self) -> "SqlUnitOfWork":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool | None:
        try:
            try:
                if exc_type is not None:
                    self.rollback()
            finally:
                self._session.close()
        except SQLAlchemyError as cleanup_error:
            raise DependencyError(
                "DatabaseCleanupFailed", "Database transaction cleanup failed"
            ) from cleanup_error
        if isinstance(exc, SQLAlchemyError):
            raise DependencyError("DatabaseReadFailed", "Database operation failed") from exc
        return None

    def commit(self) -> None:
        changes = {
            "songIds": list(self.songs.changed),
            "deletedIds": list(self.songs.deleted),
            "playedIds": list(self.history.played),
        }
        try:
            with self._catalog_lock if any(changes.values()) else nullcontext():
                self._session.commit()
                self._clear_changes()
                if any(changes.values()) and self._notify:
                    self._notify(changes)
        except SQLAlchemyError as exc:
            self.rollback()
            logger.exception("Database transaction failed")
            raise DependencyError("DatabaseWriteFailed", "Database transaction failed") from exc

    def rollback(self) -> None:
        self._session.rollback()
        self._clear_changes()

    def _clear_changes(self) -> None:
        self.songs.changed.clear()
        self.songs.deleted.clear()
        self.history.played.clear()


def _configure_sqlite(connection: sqlite3.Connection, _record: object) -> None:
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=FULL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
