from __future__ import annotations

import sqlite3
from unittest.mock import Mock

import pytest
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.domain_errors import DependencyError
from backend.infrastructure import migrations
from backend.infrastructure.database import Database, SqlUnitOfWork
from backend.infrastructure.migrations import DatabaseMigrator


@pytest.mark.parametrize("fail", [False, True])
def test_integrity_validation_closes_its_connection(tmp_path, monkeypatch, fail):
    connections = []
    connect = sqlite3.connect

    class TrackedConnection(sqlite3.Connection):
        closed = False

        def close(self):
            self.closed = True
            super().close()

        def execute(self, *args, **kwargs):
            if fail:
                raise sqlite3.DatabaseError("injected integrity failure")
            return super().execute(*args, **kwargs)

    def tracked_connect(*args, **kwargs):
        connection = connect(*args, **kwargs, factory=TrackedConnection)
        connections.append(connection)
        return connection

    database = Database(tmp_path / "validate.db")
    monkeypatch.setattr(sqlite3, "connect", tracked_connect)
    try:
        if fail:
            with pytest.raises(DependencyError):
                database.validate()
        else:
            database.validate()
        assert len(connections) == 1 and connections[0].closed
    finally:
        for connection in connections:
            connection.close()
        database.dispose()


def test_rollback_failure_still_closes_the_unit_of_work():
    session = Mock(spec=Session)
    session.rollback.side_effect = SQLAlchemyError("injected rollback failure")
    with pytest.raises(DependencyError):
        with SqlUnitOfWork(session):
            raise ValueError("original operation failure")
    session.close.assert_called_once()


def test_failed_multi_step_migration_rolls_back_ddl_and_schema_version(tmp_path, monkeypatch):
    database = Database(tmp_path / "migration.db")

    def first(connection):
        connection.execute(text("CREATE TABLE incomplete_upgrade (value INTEGER)"))

    def second(_connection):
        raise SQLAlchemyError("injected later migration failure")

    monkeypatch.setattr(migrations, "_MIGRATIONS", {0: first, 1: second})
    try:
        with pytest.raises(DependencyError):
            DatabaseMigrator().migrate(database.engine)
        with database.engine.connect() as connection:
            tables = connection.execute(text("SELECT name FROM sqlite_master WHERE name='incomplete_upgrade'")).all()
            version = connection.execute(text("PRAGMA user_version")).scalar_one()
        assert tables == []
        assert version == 0
    finally:
        database.dispose()
