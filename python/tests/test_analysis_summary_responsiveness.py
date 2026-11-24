from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Index, event
from sqlalchemy.exc import SQLAlchemyError

from backend.analysis.domain import AnalysisState
from backend.analysis.queries import ListRecordingAnalyses
from backend.api.recording_routes import router
from backend.domain_errors import DependencyError
from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.infrastructure.orm import AnalysisRow
from backend.recordings.domain import Recording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.songs.domain import Song, SongStatus, SourceState
from backend.version import ANALYSIS_ALGORITHM_VERSION

NOW = datetime(2026, 1, 1, tzinfo=UTC)
SUMMARY_INDEX = "ix_analysis_recording_recent"


@pytest.fixture
def library(tmp_path):
    database = Database(tmp_path / "library.db")
    DatabaseMigrator().migrate(database.engine)
    app = FastAPI()
    app.include_router(router)
    app.state.container = SimpleNamespace(
        recordings=SimpleNamespace(
            list=ListRecordings(database),
            get=GetRecording(database),
            list_analyses=ListRecordingAnalyses(database),
        )
    )
    with database.create() as transaction:
        transaction.songs.add(
            Song(
                "song",
                "Title",
                "Artist",
                "source",
                SourceState.MANAGED,
                tmp_path / "song.wav",
                SongStatus.READY,
                2,
                1,
                NOW,
                NOW,
            )
        )
        transaction.commit()
    try:
        with TestClient(app) as client:
            yield database, client, tmp_path
    finally:
        database.dispose()


def _row(identity, recording_id, *, state="Succeeded", created_at=NOW, algorithm=None):
    return {
        "analysis_id": identity,
        "recording_id": recording_id,
        "song_id": "song",
        "song_revision": 2,
        "algorithm_version": algorithm or ANALYSIS_ALGORITHM_VERSION,
        "recording_identity": "recording-hash",
        "state": state,
        "section_results_json": "[]",
        "problem_regions_json": "[]",
        "error_json": None,
        "created_at": created_at,
        "updated_at": created_at,
    }


def _seed(database, root, history):
    audio = root / "recording.wav"
    audio.write_bytes(b"recorded audio")
    rows = []
    expected = {}
    with database.create() as transaction:
        for index in range(200):
            identity = f"recording-{index:03}"
            transaction.recordings.add(Recording(identity, audio, 1, 16000, 1, NOW, "song", 2))
            state = ("Succeeded", "Failed", "Running", "Queued")[index % 4]
            obsolete = index % 5 == 0
            expected[identity] = "Stale" if obsolete and state == "Succeeded" else state
            # All historical rows tie. Two newer rows also tie; their IDs decide the winner.
            rows.extend(
                _row(f"old-{index:03}-{revision:04}", identity) for revision in range(history)
            )
            rows.extend(
                [
                    _row(
                        f"z-latest-{index:03}",
                        identity,
                        state="Failed",
                        created_at=NOW + timedelta(days=1),
                    ),
                    _row(
                        f"a-latest-{index:03}",
                        identity,
                        state=state,
                        created_at=NOW + timedelta(days=1),
                        algorithm="obsolete" if obsolete else None,
                    ),
                ]
            )
        transaction.commit()
    with database.engine.begin() as connection:
        connection.execute(AnalysisRow.__table__.insert(), rows)
    return expected


@pytest.mark.parametrize("history", [2, 100])
def test_recording_page_seeks_only_the_latest_analysis_per_visible_take(library, history):
    database, client, root = library
    expected = _seed(database, root, history)
    steps = 0
    statements = []

    def progress():
        nonlocal steps
        steps += 100
        return 0

    def checkout(connection, _record, _proxy):
        connection.set_progress_handler(progress, 100)

    def checkin(connection, _record):
        if connection is not None:
            connection.set_progress_handler(None, 0)

    def observed(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append(statement)

    listeners = {"checkout": checkout, "checkin": checkin, "before_cursor_execute": observed}
    for name, listener in listeners.items():
        event.listen(database.engine, name, listener)
    try:
        response = client.get("/recordings", params={"limit": 200})
    finally:
        for name, listener in listeners.items():
            event.remove(database.engine, name, listener)
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert {item["recordingId"]: item["analysisStatus"] for item in items} == expected
    assert len(statements) <= 5, f"A page incurred {len(statements)} queries"
    assert all("problem_regions_json" not in statement for statement in statements)
    print(f"recordings=200 analyses={200 * (history + 2)} sqlite_steps={steps}")
    assert steps < 30000, f"A 200-recording page ran {steps} SQLite operations over old analyses"


def test_summary_lookup_keeps_orphans_duplicate_inputs_and_unusual_ids(library):
    database, _client, _root = library
    identities = ["absent recording", "quote'comma,bracket]", "українська 🎤"]
    rows = [_row(f"analysis-{index}", identity) for index, identity in enumerate(identities)]
    with database.engine.begin() as connection:
        connection.execute(AnalysisRow.__table__.insert(), rows)
    with database.create() as transaction:
        assert transaction.analyses.latest_summaries([]) == {}
        summaries = transaction.analyses.latest_summaries([*identities, identities[0], "missing"])
    assert set(summaries) == set(identities)
    assert all(summary.state is AnalysisState.SUCCEEDED for summary in summaries.values())
    assert all(
        summary.song_id == "song" and summary.song_revision == 2 for summary in summaries.values()
    )


@pytest.mark.parametrize("inject_failure", [False, True])
def test_existing_schema_four_gets_the_summary_index_without_changing_analyses(
    library, monkeypatch, inject_failure
):
    database, _client, _root = library
    with database.engine.begin() as connection:
        connection.exec_driver_sql(f"DROP INDEX IF EXISTS {SUMMARY_INDEX}")
        connection.execute(AnalysisRow.__table__.insert(), [_row("old-result", "old-recording")])
    with database.create() as transaction:
        before = transaction.analyses.list_for_recording("old-recording")
    create = Index.create

    def fail_index(index, *args, **kwargs):
        if index.name == SUMMARY_INDEX:
            raise SQLAlchemyError("Injected index failure")
        return create(index, *args, **kwargs)

    if inject_failure:
        with monkeypatch.context() as changes:
            changes.setattr(Index, "create", fail_index)
            with pytest.raises(DependencyError, match="Database migration failed"):
                DatabaseMigrator().migrate(database.engine)
        with database.engine.connect() as connection:
            assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == 4
            assert SUMMARY_INDEX not in {
                row[1] for row in connection.exec_driver_sql("PRAGMA index_list(analysis_results)")
            }
    assert DatabaseMigrator().migrate(database.engine) == 4
    assert DatabaseMigrator().migrate(database.engine) == 4
    with database.create() as transaction:
        assert transaction.analyses.list_for_recording("old-recording") == before
    with database.engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == 4
        assert SUMMARY_INDEX in {
            row[1] for row in connection.exec_driver_sql("PRAGMA index_list(analysis_results)")
        }
