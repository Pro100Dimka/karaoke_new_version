from __future__ import annotations

from collections.abc import Callable, Mapping

from types import MappingProxyType
from typing import cast

from sqlalchemy import Connection, Table, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from backend.domain_errors import DependencyError
from backend.infrastructure.orm import Base, HistoryRow, JobRow, RecordingRow, SongRow
from backend.version import DB_SCHEMA_VERSION

Migration = Callable[[Connection], None]


def _migration_0_to_1(connection: Connection) -> None:
    Base.metadata.create_all(connection)


def _migration_1_to_2(connection: Connection) -> None:
    existing = {
        str(row[1]) for row in connection.execute(text("PRAGMA table_info(songs)")).fetchall()
    }
    for name, sql_type in (
        ("genre", "VARCHAR(200)"),
        ("artwork_url", "VARCHAR(2000)"),
        ("video_url", "VARCHAR(2000)"),
        ("recognition_provider", "VARCHAR(100)"),
        ("recognition_external_id", "VARCHAR(300)"),
    ):
        if name not in existing:
            connection.execute(text(f"ALTER TABLE songs ADD COLUMN {name} {sql_type}"))


def _migration_2_to_3(connection: Connection) -> None:
    tables = {
        "songs": (
            ("original_filename", "VARCHAR(512)"),
            ("original_filename_normalized", "VARCHAR(512)"),
            ("detected_bpm", "FLOAT"),
            ("detected_key", "VARCHAR(32)"),
        ),
        "recordings": (
            ("display_name", "VARCHAR(300)"),
            ("file_status", "VARCHAR(32) NOT NULL DEFAULT 'Ready'"),
        ),
    }
    existing_tables = {
        str(row[0])
        for row in connection.execute(
            text("SELECT name FROM sqlite_master WHERE type = 'table'")
        ).fetchall()
    }
    for table, columns in tables.items():
        if table not in existing_tables:
            continue
        existing = {
            str(row[1])
            for row in connection.execute(text(f"PRAGMA table_info({table})")).fetchall()
        }
        for name, sql_type in columns:
            if name not in existing:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))


def _migration_3_to_4(connection: Connection) -> None:
    table_exists = connection.execute(
        text("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'analysis_results'")
    ).scalar_one_or_none()
    if table_exists is None:
        return
    existing = {
        str(row[1])
        for row in connection.execute(text("PRAGMA table_info(analysis_results)")).fetchall()
    }
    for name in ("rhythm_accuracy_percent", "note_stability_percent"):
        if name not in existing:
            connection.execute(text(f"ALTER TABLE analysis_results ADD COLUMN {name} FLOAT"))


def _ensure_query_indexes(connection: Connection) -> None:
    """Optional non-unique access paths preserve the schema-4 data contract for older builds."""
    tables: set[str] = set(
        connection.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'")).scalars()
    )
    for model in (JobRow, RecordingRow, HistoryRow, SongRow):
        table = cast(Table, model.__table__)
        if table.name not in tables:
            continue
        columns = {
            str(row[1]) for row in connection.execute(text(f"PRAGMA table_info({table.name})"))
        }
        for index in sorted(table.indexes, key=lambda item: item.name or ""):
            if (
                index.name
                and (index.name.endswith("_recent") or index.name.startswith("ix_songs_catalog_"))
                and not index.unique
                and set(index.columns.keys()) <= columns
            ):
                index.create(connection, checkfirst=True)
    if "history_events" in tables:
        # The composite has the same event_type prefix. Keeping the old index makes
        # SQLite favor a rowid/snapshot range and sort the entire matching history.
        connection.execute(text("DROP INDEX IF EXISTS ix_history_events_event_type"))


_MIGRATIONS: Mapping[int, Migration] = MappingProxyType(
    {0: _migration_0_to_1, 1: _migration_1_to_2, 2: _migration_2_to_3, 3: _migration_3_to_4}
)


class DatabaseMigrator:
    def migrate(self, engine: Engine) -> int:
        try:
            with engine.begin() as connection:
                # sqlite3 legacy transaction mode does not begin for DDL or PRAGMA.
                # Keep the entire schema upgrade, including its version, atomic.
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                version = self._version(connection)
                while version < DB_SCHEMA_VERSION:
                    migration = _MIGRATIONS.get(version)
                    if migration is None:
                        raise DependencyError(
                            "DatabaseMigrationMissing",
                            "No migration exists for the current database schema",
                            version=version,
                        )
                    migration(connection)
                    version += 1
                    connection.execute(text(f"PRAGMA user_version={version}"))
                if version > DB_SCHEMA_VERSION:
                    raise DependencyError(
                        "DatabaseTooNew", "Database schema is newer than this backend"
                    )
                if version == 4:
                    # Older clients ignore this nullable catalog field and can still read the library.
                    columns = connection.execute(text("PRAGMA table_info(songs)")).fetchall()
                    if columns and all(row[1] != "detected_language" for row in columns):
                        connection.execute(
                            text("ALTER TABLE songs ADD COLUMN detected_language VARCHAR(32)")
                        )
                    _ensure_query_indexes(connection)
                return version
        except SQLAlchemyError as exc:
            raise DependencyError("DatabaseMigrationFailed", "Database migration failed") from exc

    @staticmethod
    def _version(connection: Connection) -> int:
        value: int = connection.execute(text("PRAGMA user_version")).scalar_one()
        return int(value)
