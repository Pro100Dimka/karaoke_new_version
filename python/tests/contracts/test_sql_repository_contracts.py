from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.ai.domain import AiCapability
from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.history.domain import HistoryEvent
from backend.idempotency import IdempotencyRecord
from backend.infrastructure.database import Database
from backend.infrastructure.migrations import DatabaseMigrator
from backend.models.domain import AiModel, ModelState
from backend.processing.domain import Job, JobState, JobType
from backend.projects.domain import ProjectRevision
from backend.recordings.domain import Recording
from backend.settings.domain import BackendSettings
from backend.songs.domain import CoverState, Song, SongStatus, SourceState
from backend.version import SETTINGS_SCHEMA_VERSION
from tests.contracts.repository_contract import RepositoryCase, assert_repository_contract

_NOW = datetime(2026, 1, 1, tzinfo=UTC)


pytestmark = pytest.mark.integration


@pytest.fixture
def database(tmp_path: Path):
    value = Database(tmp_path / "contracts.db")
    DatabaseMigrator().migrate(value.engine)
    try:
        yield value
    finally:
        value.dispose()


def _song() -> Song:
    return Song(
        song_id="song-contract",
        title="Title",
        artist="Artist",
        source_identity="a" * 64,
        source_state=SourceState.MANAGED,
        source_path=Path("source.wav"),
        status=SongStatus.IMPORTED,
        active_revision=1,
        project_format_version=1,
        created_at=_NOW,
        updated_at=_NOW,
        cover_state=CoverState.FALLBACK,
    )


def _recording() -> Recording:
    return Recording(
        recording_id="recording-contract",
        file_path=Path("recording.wav"),
        duration=1.0,
        sample_rate=16_000,
        channels=1,
        created_at=_NOW,
    )


def _analysis() -> AnalysisResult:
    return AnalysisResult(
        analysis_id="analysis-contract",
        recording_id="recording-contract",
        song_id="song-contract",
        song_revision=1,
        algorithm_version="analysis-1",
        state=AnalysisState.QUEUED,
        created_at=_NOW,
        updated_at=_NOW,
        recording_identity="b" * 64,
    )


def _job() -> Job:
    return Job(
        job_id="job-contract",
        job_type=JobType.SONG_PROCESSING,
        state=JobState.QUEUED,
        created_at=_NOW,
        updated_at=_NOW,
    )


def test_song_repository_contract(database: Database) -> None:
    song = _song()
    updated = replace(song, title="Updated")
    case = RepositoryCase(
        name="songs",
        add=lambda uow, item: uow.songs.add(item),
        get=lambda uow: uow.songs.get(song.song_id),
        updated=updated,
        update=lambda uow, item: uow.songs.update(item),
        delete=lambda uow: uow.songs.delete(song.song_id),
    )
    assert_repository_contract(database, case, song)


def test_recording_repository_contract(database: Database) -> None:
    recording = _recording()
    case = RepositoryCase(
        name="recordings",
        add=lambda uow, item: uow.recordings.add(item),
        get=lambda uow: uow.recordings.get(recording.recording_id),
        delete=lambda uow: uow.recordings.delete(recording.recording_id),
    )
    assert_repository_contract(database, case, recording)


def test_analysis_repository_contract(database: Database) -> None:
    result = _analysis()
    updated = replace(result, state=AnalysisState.SUCCEEDED)
    case = RepositoryCase(
        name="analyses",
        add=lambda uow, item: uow.analyses.add(item),
        get=lambda uow: uow.analyses.get(result.analysis_id),
        updated=updated,
        update=lambda uow, item: uow.analyses.update(item),
    )
    assert_repository_contract(database, case, result)


def test_job_repository_contract(database: Database) -> None:
    job = _job()
    updated = replace(job, state=JobState.INTERRUPTED)
    case = RepositoryCase(
        name="jobs",
        add=lambda uow, item: uow.jobs.add(item),
        get=lambda uow: uow.jobs.get(job.job_id),
        updated=updated,
        update=lambda uow, item: uow.jobs.update(item),
    )
    assert_repository_contract(database, case, job)


def test_project_repository_contract(database: Database) -> None:
    revision = ProjectRevision("song-contract", 1, "c" * 64, 1, "lineage", _NOW)
    case = RepositoryCase(
        name="projects",
        add=lambda uow, item: uow.projects.add(item),
        get=lambda uow: uow.projects.get(revision.song_id, revision.revision),
    )
    assert_repository_contract(database, case, revision)


def test_model_repository_contract(database: Database) -> None:
    model = AiModel(
        "model",
        AiCapability.ASR,
        "1",
        10,
        "d" * 64,
        ModelState.MISSING,
        False,
        _NOW,
    )
    updated = replace(model, state=ModelState.READY, local_path=Path("model.bin"))
    with database.create() as transaction:
        assert transaction.models.get(model.model_id, model.version) is None
        transaction.models.add_or_update(model)
        transaction.commit()
    with database.create() as transaction:
        assert transaction.models.get(model.model_id, model.version) == model
        transaction.models.add_or_update(updated)
        transaction.commit()
    with database.create() as transaction:
        assert transaction.models.get(model.model_id, model.version) == updated


def test_settings_repository_contract(database: Database) -> None:
    settings = BackendSettings(
        settings_schema_version=SETTINGS_SCHEMA_VERSION,
        cpu_threads=2,
    )
    with database.create() as transaction:
        transaction.settings.save(settings)
        transaction.commit()
    with database.create() as transaction:
        assert transaction.settings.get() == settings


def test_idempotency_and_history_repository_contracts(database: Database) -> None:
    record = IdempotencyRecord("ImportSong", "key", "hash", "song", _NOW)
    event = HistoryEvent("event", "SongImported", _NOW, "Song", "song")
    with database.create() as transaction:
        transaction.idempotency.add(record)
        transaction.history.add(event)
        transaction.commit()
    with database.create() as transaction:
        assert transaction.idempotency.get("ImportSong", "key") == record
        assert transaction.history.list(limit=10, offset=0) == [event]
