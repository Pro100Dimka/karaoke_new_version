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


_MIGRATIONS: Mapping[int, Migration] = MappingProxyType({0: _migration_0_to_1})


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
