from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.analysis.queries import ListRecordingAnalyses
from backend.api.recording_routes import router
from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.recordings.domain import Recording
from backend.recordings.queries import GetRecording, ListRecordings
from backend.songs.domain import Song, SongStatus, SourceState
from backend.version import ANALYSIS_ALGORITHM_VERSION

NOW = datetime(2026, 1, 1, tzinfo=UTC)
LIVE_SCORE = {
    "version": 3,
    "expectedPitchSeconds": 10,
    "assessedPitchSeconds": 10,
    "hitNotes": 3,
    "totalNotes": 5,
    "pitchAccuracyPercent": 61.25,
    "meanSemitoneDeviation": 0.42,
    "rhythmAccuracyPercent": 72,
    "noteStabilityPercent": 88,
}


@pytest.fixture
def recordings(tmp_path: Path):
    database = Database(tmp_path / "recordings.db")
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
                3,
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


def _take(root: Path, identity: str, **kwargs) -> Recording:
    path = root / f"{identity}.wav"
    path.write_bytes(b"recorded audio")
    return Recording(identity, path, 1, 16000, 1, NOW, "song", 2, **kwargs)


def _analysis(recording: Recording, identity: str, **kwargs) -> AnalysisResult:
    return replace(
        AnalysisResult(
            identity,
            recording.recording_id,
            "song",
            2,
            ANALYSIS_ALGORITHM_VERSION,
            AnalysisState.SUCCEEDED,
            NOW,
            NOW,
            "identity",
        ),
        **kwargs,
    )


def test_recording_page_batches_status_and_master_source_queries(recordings) -> None:
    database, client, root = recordings
    with database.create() as transaction:
        for i in range(12):
            source = _take(
                root,
                f"source-{i}",
                session_metadata={
                    "roomPerformance": {"roomId": "room", "performanceId": i, "overallScore": 85},
                },
            )
            master = replace(
                _take(
                    root,
                    f"master-{i}",
                    session_metadata={
                        "studioMaster": {"sourceRecordingId": source.recording_id},
                        "roomPerformance": {
                            "roomId": "room",
                            "performanceId": i,
                            "overallScore": 10,
                        },
                    },
                ),
                created_at=NOW + timedelta(seconds=1),
            )
            transaction.recordings.add(source)
            transaction.recordings.add(master)
            for revision in range(8):
                transaction.analyses.add(
                    _analysis(
                        master,
                        f"analysis-{i}-{revision}",
                        created_at=NOW + timedelta(seconds=revision),
                        problem_regions=({"start": 0, "end": 1},) * 100,
                    )
                )
        transaction.commit()
    statements: list[str] = []

    def observed(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(database.engine, "before_cursor_execute", observed)
    try:
        response = client.get("/recordings", params={"limit": 12})
    finally:
        event.remove(database.engine, "before_cursor_execute", observed)
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 12
    assert all(item["analysisStatus"] == "Succeeded" for item in items)
    assert all(item["roomPerformance"]["overallScore"] == 85 for item in items)
    assert len(statements) <= 5, f"Page incurred {len(statements)} queries"
    assert not any("problem_regions_json" in sql for sql in statements), (
        "Listing a recording status must not fetch every detailed analysis result"
    )


def test_batched_status_preserves_latest_historical_and_live_results(recordings) -> None:
    database, client, root = recordings
    cases = {
        "historical": "Succeeded",
        "old-algorithm": "Stale",
        "wrong-revision": "Stale",
        "missing-song": "Stale",
        "failed": "Failed",
        "empty": "NotAnalyzed",
        "live": "Succeeded",
        "uncertain-live": "Failed",
        "stored-before-live": "Failed",
        "same-time": "Running",
    }
    with database.create() as transaction:
        for case in cases:
            score = (
                {**LIVE_SCORE, "assessedPitchSeconds": 1}
                if case == "uncertain-live"
                else LIVE_SCORE
            )
            take = _take(
                root, case, session_metadata={"karaokeNoteScore": score} if "live" in case else {}
            )
            if case == "missing-song":
                take = replace(take, song_id="deleted")
            transaction.recordings.add(take)
            if case in {"empty", "live", "uncertain-live"}:
                continue
            result = _analysis(take, f"{case}-a")
            if case == "old-algorithm":
                result = replace(result, algorithm_version="obsolete")
            elif case == "wrong-revision":
                result = replace(result, song_revision=3)
            elif case in {"failed", "stored-before-live"}:
                result = replace(result, state=AnalysisState.FAILED)
            elif case == "same-time":
                result = replace(result, state=AnalysisState.RUNNING)
                transaction.analyses.add(
                    replace(result, analysis_id=f"{case}-b", state=AnalysisState.FAILED)
                )
            transaction.analyses.add(result)
        transaction.commit()
    page = client.get("/recordings").json()
    assert {item["recordingId"]: item["analysisStatus"] for item in page["items"]} == cases
    for identity, state in cases.items():
        assert client.get(f"/recordings/{identity}").json()["analysisStatus"] == state


def test_empty_recording_page_needs_no_per_recording_queries(recordings) -> None:
    _database, client, _root = recordings
    response = client.get("/recordings")
    assert response.status_code == 200
    assert response.json()["items"] == []
