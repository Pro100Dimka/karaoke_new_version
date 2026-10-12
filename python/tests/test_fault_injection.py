from __future__ import annotations

import os
from pathlib import Path
from threading import Event

import pytest

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.database import SqlUnitOfWork
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.songs.import_song import ImportSongRequest
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def test_import_cancellation_after_copy_does_not_commit_a_song_without_files(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    write_wav(source)
    cancelled = Event()

    def progress(stage: str, value: float) -> None:
        if stage == "Copying":
            cancelled.set()

    def ensure_not_cancelled() -> None:
        if cancelled.is_set():
            raise DomainError("JobCancelled", "cancelled", 409)

    with app_client(tmp_path / "runtime") as client:
        with pytest.raises(DomainError, match="cancelled"):
            client.app.state.container.songs.import_song.execute(
                ImportSongRequest(source), progress, ensure_not_cancelled
            )
        assert client.get("/songs").json()["items"] == []
        assert source.is_file()


def test_import_committed_before_cancellation_keeps_its_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.wav"
    write_wav(source)
    cancelled = Event()
    original_commit = SqlUnitOfWork.commit

    def commit_then_cancel(transaction: SqlUnitOfWork) -> None:
        original_commit(transaction)
        cancelled.set()

    def ensure_not_cancelled() -> None:
        if cancelled.is_set():
            raise DomainError("JobCancelled", "cancelled", 409)

    with app_client(tmp_path / "runtime") as client:
        monkeypatch.setattr(SqlUnitOfWork, "commit", commit_then_cancel)
        song = client.app.state.container.songs.import_song.execute(
            ImportSongRequest(source), ensure_not_cancelled=ensure_not_cancelled
        )
        assert cancelled.is_set()
        assert song.source_path.read_bytes() == source.read_bytes()
        assert client.get(f"/songs/{song.song_id}").status_code == 200


def _ready_song(root: Path, source: Path) -> tuple[str, int]:
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        result = wait_for_job(client, started.json()["jobId"])
        assert result["state"] == "Succeeded"
        current = client.get(f"/songs/{song['songId']}").json()
        return str(current["songId"]), int(current["activeRevision"])


def test_failed_atomic_rename_preserves_canonical_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "canonical.json"
    target.write_text("old", encoding="utf-8")

    def fail_replace(source: os.PathLike[str] | str, destination: os.PathLike[str] | str) -> None:
        del source, destination
        raise OSError("injected rename failure")

    monkeypatch.setattr(os, "replace", fail_replace)

    with pytest.raises(DependencyError) as raised:
        atomic_write_text(target, "new")

    assert raised.value.code == "StorageUnavailable"
    assert target.read_text(encoding="utf-8") == "old"
    assert not target.with_name(".canonical.json.tmp").exists()


def test_db_commit_failure_is_recovered_without_losing_old_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    song_id, old_revision = _ready_song(root, source)

    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        editor = client.app.state.container.songs.get_editor.execute(song_id)
        original_commit = SqlUnitOfWork.commit

        def fail_commit(self: SqlUnitOfWork) -> None:
            raise DependencyError("DatabaseWriteFailed", "injected DB commit failure")

        monkeypatch.setattr(SqlUnitOfWork, "commit", fail_commit)
        with pytest.raises(DependencyError):
            client.app.state.container.songs.save_editor.execute(
                song_id,
                editor.revision,
                editor.document,
            )
        monkeypatch.setattr(SqlUnitOfWork, "commit", original_commit)

        current = client.get(f"/songs/{song_id}").json()
        assert current["activeRevision"] == old_revision
        orphan = root / "songs" / song_id / "revisions" / str(old_revision + 1)
        assert orphan.is_dir()

    with app_client(root) as client:
        assert client.get(f"/songs/{song_id}").json()["activeRevision"] == old_revision
        assert client.app.state.container.startup_recovery.recovered_transactions >= 1

    assert not (root / "songs" / song_id / "revisions" / str(old_revision + 1)).exists()

    with app_client(root) as client:
        assert client.get(f"/songs/{song_id}").json()["activeRevision"] == old_revision
        assert client.app.state.container.startup_recovery.recovered_transactions == 0


def test_work_cleanup_is_idempotent(tmp_path: Path) -> None:
    storage = LocalWorkStorage(tmp_path / "work")
    workspace = storage.allocate("cleanup")
    (workspace / "temporary.bin").write_bytes(b"x")

    storage.cleanup(workspace)
    storage.cleanup(workspace)

    assert not workspace.exists()
