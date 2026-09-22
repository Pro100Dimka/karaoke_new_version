from __future__ import annotations

import pytest
import shutil
import os
from pathlib import Path

from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.local_songs import LocalSongStorage
from backend.infrastructure.recovery_journal import FileRecoveryJournal
from backend.recovery.domain import RecoveryOperation
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
