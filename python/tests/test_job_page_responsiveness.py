from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import Index, text
from sqlalchemy.exc import SQLAlchemyError

from backend.domain_errors import DependencyError
from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.orm import JobRow
from backend.processing.domain import JobType

_PAGE_INDEXES = {"ix_jobs_recent", "ix_jobs_type_recent", "ix_jobs_entity_recent"}


def _rows(count: int) -> list[dict[str, object]]:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return [
        {
            "job_id": f"job-{index:06}",
            "job_type": JobType.SONG_PROCESSING.value
            if index % 2
            else JobType.MODEL_DOWNLOAD.value,
            "state": "Succeeded",
            "entity_id": "song" if index % 4 else "other",
            "stage_progress": 1.0,
            "overall_progress": 1.0,
            "created_at": now + timedelta(seconds=index // 3),
            "updated_at": now,
        }
        for index in range(count)
    ]


@pytest.mark.parametrize("kind", ["all", "type", "entity", "both"])
def test_job_page_does_not_sort_every_historical_job(tmp_path: Path, kind: str) -> None:
    database = Database(tmp_path / "jobs.db")
    DatabaseMigrator().migrate(database.engine)
    rows = _rows(3000)
    with database.engine.begin() as connection:
        connection.execute(JobRow.__table__.insert(), rows)
    filters = {"job_type": JobType.SONG_PROCESSING} if kind in {"type", "both"} else {}
    if kind in {"entity", "both"}:
        filters["entity_id"] = "song"
    relevant = [
        row
        for row in rows
        if (kind not in {"type", "both"} or row["job_type"] == JobType.SONG_PROCESSING.value)
        and (kind not in {"entity", "both"} or row["entity_id"] == "song")
    ]
    relevant.sort(key=lambda row: str(row["job_id"]))
    relevant.sort(key=lambda row: row["created_at"], reverse=True)
    steps = 0

    def progress():
        nonlocal steps
        steps += 100
        return 0

    try:
        with database.create() as transaction:
            connection = transaction._session.connection().connection.driver_connection
            connection.set_progress_handler(progress, 100)
            try:
                page = transaction.jobs.list(limit=20, offset=10, **filters)
            finally:
                connection.set_progress_handler(None, 0)
        assert [job.job_id for job in page] == [row["job_id"] for row in relevant[10:30]]
        assert steps < 5000, f"A 20-job page ran {steps} SQLite operations over stored history"
    finally:
        database.dispose()


def _schema_four(path: Path) -> Database:
    database = Database(path)
    DatabaseMigrator().migrate(database.engine)
    with database.engine.begin() as connection:
        for name in _PAGE_INDEXES:
            connection.exec_driver_sql(f"DROP INDEX IF EXISTS {name}")
        connection.exec_driver_sql("PRAGMA user_version=4")
        connection.execute(JobRow.__table__.insert(), _rows(30))
    return database


def test_optional_indexes_preserve_schema_four_and_existing_jobs(tmp_path: Path) -> None:
    database = _schema_four(tmp_path / "old.db")
    try:
        with database.create() as transaction:
            before = transaction.jobs.list(limit=100, offset=0)
        assert DatabaseMigrator().migrate(database.engine) == 4
        assert DatabaseMigrator().migrate(database.engine) == 4
        with database.create() as transaction:
            assert transaction.jobs.list(limit=100, offset=0) == before
        with database.engine.connect() as connection:
            indexes = {row[1] for row in connection.exec_driver_sql("PRAGMA index_list(jobs)")}
            assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == 4
        assert _PAGE_INDEXES <= indexes
    finally:
        database.dispose()


def test_failed_index_upgrade_rolls_back_indexes_and_version(tmp_path: Path, monkeypatch) -> None:
    database = _schema_four(tmp_path / "failed.db")
    create = Index.create
    attempted = 0

    def fail_second(index, *args, **kwargs):
        nonlocal attempted
        if index.name in _PAGE_INDEXES:
            attempted += 1
            if attempted == 2:
                raise SQLAlchemyError("injected index failure")
        return create(index, *args, **kwargs)

    try:
        with monkeypatch.context() as changes:
            changes.setattr(Index, "create", fail_second)
            with pytest.raises(DependencyError, match="Database migration failed"):
                DatabaseMigrator().migrate(database.engine)
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == 4
            indexes = {row[1] for row in connection.exec_driver_sql("PRAGMA index_list(jobs)")}
            assert not indexes & _PAGE_INDEXES
            assert connection.execute(text("SELECT COUNT(*) FROM jobs")).scalar_one() == 30
        assert DatabaseMigrator().migrate(database.engine) == 4
    finally:
        database.dispose()
