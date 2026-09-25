from __future__ import annotations

import sqlite3
import logging
from contextlib import closing
from pathlib import Path
from types import TracebackType

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from backend.domain_errors import DependencyError
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
    def __init__(self, path: Path) -> None:
        self.path = path
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
        return SqlUnitOfWork(self._sessions())

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

    def ping(self) -> bool:
        try:
            with self._engine.connect() as connection:
                connection.execute(text("SELECT 1"))
            return True
        except SQLAlchemyError:
            return False

    def dispose(self) -> None:
        self._engine.dispose()


class SqlUnitOfWork(UnitOfWork):
    def __init__(self, session: Session) -> None:
        self._session = session
        self.songs = SqlSongRepository(session)
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
        try:
            self._session.commit()
        except SQLAlchemyError as exc:
            self._session.rollback()
            logger.exception("Database transaction failed")
            raise DependencyError("DatabaseWriteFailed", "Database transaction failed") from exc

    def rollback(self) -> None:
        self._session.rollback()


def _configure_sqlite(connection: sqlite3.Connection, _record: object) -> None:
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=FULL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()
