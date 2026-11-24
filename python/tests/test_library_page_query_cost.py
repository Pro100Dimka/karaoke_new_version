from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import event, insert, text

from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.orm import HistoryRow, RecordingRow


@pytest.fixture
def library(tmp_path: Path):
    database = Database(tmp_path / "library.db")
    DatabaseMigrator().migrate(database.engine)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    with database.engine.begin() as connection:
        connection.execute(
            insert(HistoryRow),
            [
                {
                    "event_id": f"event-{index:05}",
                    "event_type": ("RecordingRegistered", "AnalysisCompleted", "Other")[index % 3],
                    "created_at": now,
                }
                for index in range(6000)
            ],
        )
        connection.execute(
            insert(RecordingRow),
            [
                {
                    "recording_id": f"take-{index:05}",
                    "song_id": f"song-{index % 2}",
                    "file_path": str(tmp_path / f"{index}.flac"),
                    "duration": 1,
                    "sample_rate": 48000,
                    "channels": 2,
                    "created_at": now,
                    "gaps_json": "[]",
                    "session_json": "null",
                }
                for index in range(6000)
            ],
        )
    try:
        yield database
    finally:
        database.dispose()


@contextmanager
def query_work(database):
    steps = []
    connections = set()

    def measure(connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            raw = connection.connection.driver_connection
            connections.add(raw)
            raw.set_progress_handler(lambda: steps.append(100), 100)

    event.listen(database.engine, "before_cursor_execute", measure)
    try:
        yield steps
    finally:
        event.remove(database.engine, "before_cursor_execute", measure)
        for connection in connections:
            connection.set_progress_handler(None, 0)


@pytest.mark.parametrize(
    "kinds",
    [None, ["RecordingRegistered"], ["RecordingRegistered", "AnalysisCompleted"]],
)
def test_history_first_page_does_not_sort_the_entire_history(library, kinds):
    expected = [
        f"event-{index:05}"
        for index in range(6000)
        if kinds is None or ("RecordingRegistered", "AnalysisCompleted", "Other")[index % 3] in kinds
    ]
    with query_work(library) as steps, library.create() as transaction:
        page = transaction.history.list(limit=20, offset=7, event_types=kinds, snapshot=6000)
    assert [item.event_id for item in page] == expected[7:27]
    assert sum(steps) < 6000, f"A 20-row history page required {sum(steps)} SQLite VM steps"


@pytest.mark.parametrize("song_id", [None, "song-1"])
def test_recording_first_page_does_not_sort_all_saved_takes(library, song_id):
    expected = [
        f"take-{index:05}"
        for index in range(6000)
        if song_id is None or f"song-{index % 2}" == song_id
    ]
    with query_work(library) as steps, library.create() as transaction:
        page = transaction.recordings.list(song_id=song_id, limit=20, offset=7)
    assert [item.recording_id for item in page] == expected[7:27]
    assert sum(steps) < 6000, f"A 20-row recordings page required {sum(steps)} SQLite VM steps"


@pytest.mark.parametrize("offset", [0, 31, 3970, 4000, 2**63 - 1])
def test_history_filter_merge_preserves_snapshot_ties_and_empty_pages(library, offset):
    kinds = ["RecordingRegistered", "AnalysisCompleted", "RecordingRegistered"]
    expected = [f"event-{index:05}" for index in range(5997) if index % 3 < 2]
    with library.create() as transaction:
        page = transaction.history.list(limit=31, offset=offset, event_types=kinds, snapshot=5997)
        assert [item.event_id for item in page] == expected[offset : offset + 31]
        assert transaction.history.count(kinds, snapshot=5997) == len(expected)
        assert not transaction.history.list(limit=31, offset=0, event_types=[])


def test_query_indexes_are_installed_on_an_existing_schema_four_library(library):
    # Simulate an existing installation with data and only its original indexes.
    with library.engine.begin() as connection:
        for name in (
            "ix_history_recent",
            "ix_history_type_recent",
            "ix_recordings_recent",
            "ix_recordings_song_recent",
        ):
            connection.execute(text(f"DROP INDEX IF EXISTS {name}"))
        connection.execute(
            text("CREATE INDEX IF NOT EXISTS ix_history_events_event_type ON history_events(event_type)")
        )
    DatabaseMigrator().migrate(library.engine)
    DatabaseMigrator().migrate(library.engine)
    with query_work(library) as steps, library.create() as transaction:
        history = transaction.history.list(limit=20, offset=0, event_types=["AnalysisCompleted"])
        recordings = transaction.recordings.list(song_id="song-1", limit=20, offset=0)
    assert len(history) == len(recordings) == 20
    assert sum(steps) < 6000
    with library.engine.connect() as connection:
        assert connection.execute(text("PRAGMA user_version")).scalar_one() == 4
        assert connection.execute(text("SELECT COUNT(*) FROM history_events")).scalar_one() == 6000
        assert connection.execute(text("SELECT COUNT(*) FROM recordings")).scalar_one() == 6000
