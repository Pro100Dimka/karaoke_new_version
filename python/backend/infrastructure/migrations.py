from __future__ import annotations

from collections.abc import Callable, Mapping

from types import MappingProxyType

from sqlalchemy import Connection, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError

from backend.domain_errors import DependencyError
from backend.infrastructure.orm import Base
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
    for table, columns in tables.items():
        existing = {
            str(row[1])
            for row in connection.execute(text(f"PRAGMA table_info({table})")).fetchall()
        }
        for name, sql_type in columns:
            if name not in existing:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}"))


_MIGRATIONS: Mapping[int, Migration] = MappingProxyType(
    {0: _migration_0_to_1, 1: _migration_1_to_2, 2: _migration_2_to_3}
)


class DatabaseMigrator:
    def migrate(self, engine: Engine) -> int:
        try:
            with engine.begin() as connection:
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
                return version
        except SQLAlchemyError as exc:
            raise DependencyError("DatabaseMigrationFailed", "Database migration failed") from exc

    @staticmethod
    def _version(connection: Connection) -> int:
        value = connection.execute(text("PRAGMA user_version")).scalar_one()
        return int(value)
