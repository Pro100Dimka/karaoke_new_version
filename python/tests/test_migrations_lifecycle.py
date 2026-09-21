from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

import pytest

import backend.infrastructure.migrations as migrations
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from backend.bootstrap.config import BackendConfig
from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.infrastructure.database import Database
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.migrations import DatabaseMigrator
from backend.processing.domain import Job, JobState, JobType
from backend.settings.domain import BackendSettings
from backend.songs.domain import SongStatus
from backend.storage.domain import StorageRoots
from backend.settings.update_settings import ValidateSettingsSchema
from backend.version import DB_SCHEMA_VERSION, SETTINGS_SCHEMA_VERSION
from tests.conftest import app_client, write_wav
from tests.fakes import FakeClock
from tests.helpers import import_song


pytestmark = pytest.mark.integration


def test_database_migration_creates_current_schema(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    try:
        version = DatabaseMigrator().migrate(database.engine)
        with database.engine.connect() as connection:
            stored = int(connection.execute(text("PRAGMA user_version")).scalar_one())
        assert version == DB_SCHEMA_VERSION
        assert stored == DB_SCHEMA_VERSION
        database.validate()
    finally:
        database.dispose()


def test_database_migration_rejects_newer_schema(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    try:
        with database.engine.begin() as connection:
            connection.execute(text(f"PRAGMA user_version={DB_SCHEMA_VERSION + 1}"))
        with pytest.raises(DependencyError) as raised:
            DatabaseMigrator().migrate(database.engine)
        assert raised.value.code == "DatabaseTooNew"
    finally:
        database.dispose()


def test_settings_schema_upgrades_old_document() -> None:
    upgraded = ValidateSettingsSchema().execute(BackendSettings(settings_schema_version=0))
    assert upgraded.settings_schema_version == SETTINGS_SCHEMA_VERSION


def test_settings_schema_rejects_newer_document() -> None:
    with pytest.raises(DomainError) as raised:
        ValidateSettingsSchema().execute(
            BackendSettings(settings_schema_version=SETTINGS_SCHEMA_VERSION + 1)
        )
    assert raised.value.code == "SettingsVersionUnsupported"


def test_instance_lock_rejects_second_writer_and_can_be_reacquired(tmp_path: Path) -> None:
    path = tmp_path / "backend.lock"
    first = BackendInstanceLock(path)
    second = BackendInstanceLock(path)
    first.acquire()
    try:
        with pytest.raises(ConflictError) as raised:
            second.acquire()
        assert raised.value.code == "BackendAlreadyRunning"
    finally:
        first.release()
    second.acquire()
    second.release()
    assert not path.exists()


def test_app_shutdown_releases_instance_lock(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    with app_client(root) as client:
        assert client.get("/health/live").status_code == 200
        assert (root / "backend.lock").is_file()
    assert not (root / "backend.lock").exists()
    with app_client(root) as client:
        assert client.get("/health/ready").status_code == 200


def test_startup_marks_running_job_interrupted(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    config = BackendConfig.load(root)
    config.roots.app.mkdir(parents=True, exist_ok=True)
    database = Database(config.roots.database)
    clock = FakeClock()
    try:
        DatabaseMigrator().migrate(database.engine)
        job = Job(
            job_id="interrupted-job",
            job_type=JobType.SONG_PROCESSING,
            state=JobState.RUNNING,
            created_at=clock.now(),
            started_at=clock.now(),
            updated_at=clock.now(),
        )
        with database.create() as transaction:
            transaction.jobs.add(job)
            transaction.commit()
    finally:
        database.dispose()

    with app_client(root) as client:
        response = client.get("/jobs/interrupted-job")
        assert response.status_code == 200
        assert response.json()["state"] == "Interrupted"
        assert client.app.state.container.startup_recovery.interrupted_jobs == 1


def test_database_migration_failure_keeps_schema_version_uncommitted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database = Database(tmp_path / "failed.db")

    def fail_migration(connection) -> None:
        del connection
        raise SQLAlchemyError("injected migration failure")

    monkeypatch.setattr(
        migrations,
        "_MIGRATIONS",
        MappingProxyType({0: fail_migration}),
    )
    try:
        with pytest.raises(DependencyError) as raised:
            DatabaseMigrator().migrate(database.engine)
        with database.engine.connect() as connection:
            stored = int(connection.execute(text("PRAGMA user_version")).scalar_one())
        assert raised.value.code == "DatabaseMigrationFailed"
        assert stored == 0
    finally:
        database.dispose()


def test_song_left_processing_by_a_crash_becomes_failed_at_startup(tmp_path: Path) -> None:
    root = tmp_path / "runtime-orphaned-song"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root) as client:
        song = import_song(client, source)
    database = Database(StorageRoots.under(root).database)
    try:
        with database.create() as transaction:
            stored = transaction.songs.get(song["songId"])
            assert stored is not None
            transaction.songs.update(replace(stored, status=SongStatus.PROCESSING))
            transaction.commit()
    finally:
        database.dispose()

    with app_client(root) as client:
        assert client.get(f"/songs/{song['songId']}").json()["status"] == "Failed"
        assert client.app.state.container.startup_recovery.failed_songs == 1
