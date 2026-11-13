from __future__ import annotations

import pytest
import shutil
import os
from pathlib import Path

from backend.infrastructure.ids import UuidGenerator
from backend.domain_errors import DependencyError
from backend.infrastructure.local_songs import LocalSongStorage
from backend.infrastructure.recovery_journal import FileRecoveryJournal
from backend.recovery.domain import RecoveryOperation
from backend.songs.delete_song import DeleteSong
from backend.storage.domain import StorageRoots
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider, FakeClock
from tests.helpers import import_song, wait_for_job


pytestmark = pytest.mark.integration


def _ready_song(root: Path, tmp_path: Path) -> tuple[str, int]:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        response = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        job = wait_for_job(client, response.json()["jobId"])
        assert job["state"] == "Succeeded"
        current = client.get(f"/songs/{song['songId']}").json()
        return str(current["songId"]), int(current["activeRevision"])


def _journal(root: Path) -> FileRecoveryJournal:
    roots = StorageRoots.under(root)
    return FileRecoveryJournal(roots.recovery, FakeClock(), UuidGenerator())


def test_song_quarantine_retries_a_transient_windows_file_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    roots = StorageRoots.under(tmp_path / "runtime")
    source = roots.songs / "song-id"
    source.mkdir(parents=True)
    (source / "clip.mp4").write_bytes(b"video")
    storage = LocalSongStorage(roots)
    real_replace = os.replace
    attempts = 0

    def locked_then_available(left: Path, right: Path) -> None:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise PermissionError("file is temporarily in use")
        real_replace(left, right)

    monkeypatch.setattr(os, "replace", locked_then_available)

    quarantine = storage.quarantine("song-id")

    assert attempts == 3
    assert quarantine is not None and quarantine.is_dir()


def test_startup_rolls_back_uncommitted_published_revision(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    song_id, revision = _ready_song(root, tmp_path)
    source_revision = root / "songs" / song_id / "revisions" / str(revision)
    orphan_revision = source_revision.parent / str(revision + 1)
    shutil.copytree(source_revision, orphan_revision)
    _journal(root).begin(
        RecoveryOperation.PROJECT_PUBLISH,
        {"songId": song_id, "revision": revision + 1, "working": "unused"},
    )

    with app_client(root) as client:
        recovery = client.app.state.container.startup_recovery
        assert recovery.recovered_transactions == 1
        assert recovery.pending_transactions == 0
        assert client.get(f"/songs/{song_id}").json()["activeRevision"] == revision

    assert not orphan_revision.exists()
    assert _journal(root).entries() == ()


def test_startup_keeps_committed_revision_when_only_journal_completion_was_interrupted(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtime"
    song_id, revision = _ready_song(root, tmp_path)
    current_revision = root / "songs" / song_id / "revisions" / str(revision)
    _journal(root).begin(
        RecoveryOperation.PROJECT_PUBLISH,
        {"songId": song_id, "revision": revision, "working": "unused"},
    )

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
        assert client.get(f"/songs/{song_id}").json()["activeRevision"] == revision

    assert current_revision.is_dir()
    assert _journal(root).entries() == ()


@pytest.mark.parametrize(
    "operation", [RecoveryOperation.PROJECT_PUBLISH, RecoveryOperation.PACKAGE_IMPORT]
)
def test_startup_keeps_a_committed_revision_after_the_active_revision_advances(
    tmp_path: Path, operation: RecoveryOperation
) -> None:
    root = tmp_path / "runtime"
    song_id, revision = _ready_song(root, tmp_path)
    previous = root / "songs" / song_id / "revisions" / str(revision)
    original = (previous / "lyricsSync.json").read_bytes()
    with app_client(root) as client:
        # A successful DB commit may leave its journal entry if completion failed. A later save
        # is still possible in that process, but must not turn the first revision into an orphan.
        _journal(root).begin(operation, {"songId": song_id, "revision": revision})
        opened = client.get(f"/songs/{song_id}/editor").json()
        saved = client.put(
            f"/songs/{song_id}/editor",
            json={"expectedRevision": revision, "document": opened["document"]},
        )
        assert saved.status_code == 200, saved.text

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
        assert client.get(f"/songs/{song_id}").json()["activeRevision"] == revision + 1

    assert previous.is_dir(), "Committed history must survive recovery after a later save"
    assert (previous / "lyricsSync.json").read_bytes() == original
    assert _journal(root).entries() == ()


def test_startup_restores_quarantined_song_when_delete_db_commit_did_not_happen(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root) as client:
        song = import_song(client, source)
    song_id = str(song["songId"])
    storage = LocalSongStorage(StorageRoots.under(root))
    quarantine = storage.quarantine(song_id)
    assert quarantine is not None and quarantine.exists()
    _journal(root).begin(
        RecoveryOperation.SONG_DELETE,
        {"songId": song_id, "quarantine": str(quarantine)},
    )

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
        assert client.get(f"/songs/{song_id}").status_code == 200

    assert (root / "songs" / song_id).is_dir()
    assert not quarantine.exists()


def test_startup_removes_uncommitted_import_files(tmp_path: Path) -> None:
    root = tmp_path / "runtime"
    orphan_id = "orphan-import"
    orphan_root = root / "songs" / orphan_id
    orphan_root.mkdir(parents=True)
    (orphan_root / "partial.bin").write_bytes(b"partial")
    roots = StorageRoots.under(root)
    roots.recovery.mkdir(parents=True, exist_ok=True)
    _journal(root).begin(
        RecoveryOperation.IMPORT_SONG,
        {"songId": orphan_id, "sourceIdentity": "hash"},
    )

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.recovered_transactions == 1

    assert not orphan_root.exists()
    assert _journal(root).entries() == ()


def test_delete_does_not_move_song_files_if_recovery_journal_cannot_be_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root) as client:
        song = import_song(client, source)
        song_id = str(song["songId"])
        directory = root / "songs" / song_id
        original = {
            path.relative_to(directory): path.read_bytes()
            for path in directory.rglob("*")
            if path.is_file()
        }

        def fail_journal(*args, **kwargs):
            raise DependencyError("StorageUnavailable", "injected journal write failure")

        with monkeypatch.context() as failure:
            failure.setattr(FileRecoveryJournal, "begin", fail_journal)
            response = client.delete(f"/songs/{song_id}")
            assert response.status_code == 503, response.text

        assert client.get(f"/songs/{song_id}").status_code == 200
        assert directory.is_dir(), "A failed journal write must not hide the working project"
        assert {
            path.relative_to(directory): path.read_bytes()
            for path in directory.rglob("*")
            if path.is_file()
        } == original
        assert not (root / "quarantine" / f"song-{song_id}").exists()
        assert client.delete(f"/songs/{song_id}").status_code == 204


def test_delete_restores_quarantine_when_metadata_commit_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root) as client:
        song_id = str(import_song(client, source)["songId"])
        directory = root / "songs" / song_id
        original = {
            path.relative_to(directory): path.read_bytes()
            for path in directory.rglob("*")
            if path.is_file()
        }

        def fail_commit(*_args: object) -> None:
            raise DependencyError("StorageUnavailable", "injected metadata failure")

        with monkeypatch.context() as failure:
            failure.setattr(DeleteSong, "_delete_metadata", fail_commit)
            assert client.delete(f"/songs/{song_id}").status_code == 503

        assert client.get(f"/songs/{song_id}").status_code == 200
        assert {
            path.relative_to(directory): path.read_bytes()
            for path in directory.rglob("*")
            if path.is_file()
        } == original
        assert _journal(root).entries() == ()


@pytest.mark.parametrize("phase", ["before_move", "after_move", "after_commit"])
def test_recording_delete_recovers_interrupted_publication(tmp_path: Path, monkeypatch, phase):
    from datetime import datetime, UTC
    from backend.infrastructure.database import Database
    from backend.infrastructure.recording_files import LocalRecordingStorage
    from backend.recordings.delete_recording import DeleteRecording

    root = tmp_path / "runtime"
    with app_client(root) as client:
        target = client.post("/recordings/target").json()
        path = Path(target["filePath"])
        write_wav(path)
        response = client.post(
            "/recordings",
            json={
                **target,
                "duration": 1,
                "sampleRate": 16000,
                "channels": 1,
                "createdAt": datetime.now(UTC).isoformat(),
            },
        )
        assert response.status_code == 201, response.text
    original = path.read_bytes()
    storage = LocalRecordingStorage(StorageRoots.under(root))
    move = storage.quarantine

    def interrupted_move(recording_id, file_path):
        if phase == "before_move":
            raise SystemExit("interrupted before rename")
        result = move(recording_id, file_path)
        if phase == "after_move":
            raise SystemExit("interrupted after rename")
        return result

    def interrupted_finalize(_path):
        raise SystemExit("interrupted after commit")

    monkeypatch.setattr(storage, "quarantine", interrupted_move)
    monkeypatch.setattr(storage, "finalize_quarantine", interrupted_finalize)
    database = Database(root / "app.db")
    try:
        operation = DeleteRecording(database, storage, _journal(root))
        with pytest.raises(SystemExit):
            operation.execute(target["recordingId"])
    finally:
        database.dispose()
    with app_client(root) as client:
        response = client.get("/recordings/" + target["recordingId"])
        if phase == "after_commit":
            assert response.status_code == 404
            assert not storage.quarantine_path(target["recordingId"], path).parent.exists()
        else:
            assert response.status_code == 200
            assert path.read_bytes() == original
    assert _journal(root).entries() == ()
