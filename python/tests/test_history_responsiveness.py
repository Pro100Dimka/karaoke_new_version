from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import event

from backend.history.domain import HistoryEvent
from backend.history.queries import ListHistory
from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.recordings.domain import Recording


def test_history_resolves_recording_songs_without_repeated_metadata_reads(tmp_path: Path) -> None:
    database = Database(tmp_path / "history.db")
    DatabaseMigrator().migrate(database.engine)
    now = datetime(2026, 1, 1, tzinfo=UTC)
    expected: dict[str, str | None] = {}
    with database.create() as transaction:
        for index in range(20):
            recording = Recording(
                f"recording-{index}",
                tmp_path / f"{index}.wav",
                1,
                48000,
                2,
                now,
                song_id=f"song-{index}" if index else None,
                session_metadata={"performance": [{"note": i} for i in range(100)]},
            )
            transaction.recordings.add(recording)
            for repeated in range(3):
                identity = f"event-{index:02}-{repeated}"
                transaction.history.add(
                    HistoryEvent(
                        identity, "AnalysisCompleted", now, "Recording", recording.recording_id
                    )
                )
                expected[identity] = recording.song_id
        for identity, kind, entity in (
            ("missing", "Recording", "deleted"),
            ("direct", "Song", "direct-song"),
            ("unrelated", "Model", "model"),
        ):
            transaction.history.add(
                HistoryEvent(identity, "Other", now + timedelta(seconds=1), kind, entity)
            )
        transaction.commit()
    statements: list[str] = []

    def observed(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(database.engine, "before_cursor_execute", observed)
    try:
        page = ListHistory(database).execute(limit=100, offset=0)
        assert page.total == 63
        assert page.song_ids == {**expected, "missing": None, "direct": "direct-song"}
        snapshot_reads = [query for query in statements if query.startswith("SELECT max(")]
        assert len(snapshot_reads) == 1
        assert len(statements) - len(snapshot_reads) <= 3
        assert all("session_json" not in statement for statement in statements)
        assert all("gaps_json" not in statement for statement in statements)

        statements.clear()
        filtered = ListHistory(database).execute(
            limit=10, offset=5, event_types=["AnalysisCompleted"], snapshot=page.snapshot
        )
        assert filtered.total == 60
        assert [item.event_id for item in filtered.items] == sorted(expected)[5:15]
        assert filtered.song_ids == {
            item.event_id: expected[item.event_id] for item in filtered.items
        }
        assert len(statements) <= 3

        statements.clear()
        empty = ListHistory(database).execute(limit=10, offset=100, snapshot=page.snapshot)
        assert not empty.items and not empty.song_ids
        assert len(statements) == 2
    finally:
        event.remove(database.engine, "before_cursor_execute", observed)
        database.dispose()
