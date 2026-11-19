from __future__ import annotations

import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Lock

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.local_songs import LocalSongStorage
from backend.songs.update_song import UpdateSongRequest
from backend.storage.domain import StorageRoots
from tests.conftest import write_wav
from tests.helpers import import_song


def _storage_with_clip(tmp_path: Path):
    storage = LocalSongStorage(StorageRoots.under(tmp_path / "library"))
    source = tmp_path / "video.mp4"
    source.write_bytes(b"original-video")
    target = storage.copy_clip("song", source)
    source.write_bytes(b"replacement-video")
    return storage, source, target


def test_rollback_preserves_an_external_replacement_during_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, source, target = _storage_with_clip(tmp_path)
    original_copy = storage.copy_clip
    external = tmp_path / "external.mp4"
    external.write_bytes(b"newer-external-publication")

    def copy_then_publish(song_id: str, selected: Path) -> Path:
        result = original_copy(song_id, selected)
        os.replace(external, result)
        return result

    monkeypatch.setattr(storage, "copy_clip", copy_then_publish)
    with pytest.raises(DependencyError, match="save interrupted"):
        with storage.media_update("song") as update:
            update.copy_clip(source)
            raise DependencyError("DatabaseWriteFailed", "save interrupted")

    assert target.read_bytes() == b"newer-external-publication"
    assert not tuple(target.parent.glob("*.backup"))


def test_failed_restore_keeps_the_backup_and_the_original_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    storage, source, target = _storage_with_clip(tmp_path)
    replace = os.replace

    def block_restore(src: Path, dest: Path) -> None:
        if Path(src).suffix == ".backup":
            raise PermissionError("Media is in use")
        replace(src, dest)

    monkeypatch.setattr(os, "replace", block_restore)
    with pytest.raises(DependencyError, match="save interrupted"):
        with storage.media_update("song") as update:
            update.copy_clip(source)
            raise DependencyError("DatabaseWriteFailed", "save interrupted")

    backups = tuple(target.parent.glob("*.backup"))
    assert len(backups) == 1 and backups[0].read_bytes() == b"original-video"
    assert "Could not restore song media" in caplog.text


def test_backup_cleanup_failure_does_not_fail_a_committed_save(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    storage, source, target = _storage_with_clip(tmp_path)
    unlink = Path.unlink

    def block_cleanup(path: Path, *args, **kwargs):
        if path.suffix == ".backup":
            raise PermissionError("Backup is in use")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", block_cleanup)
    with storage.media_update("song") as update:
        update.copy_clip(source)
        update.commit()

    assert target.read_bytes() == source.read_bytes()
    assert "Could not remove media backup" in caplog.text


def test_reselecting_managed_media_does_not_copy_a_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage, _source, target = _storage_with_clip(tmp_path)

    def forbid_copy(*_args: object) -> None:
        raise OSError("No space for an unnecessary media copy")

    monkeypatch.setattr(shutil, "copyfileobj", forbid_copy)
    with storage.media_update("song") as update:
        assert update.copy_clip(target) == target
        update.commit()

    assert target.read_bytes() == b"original-video"


def test_failed_concurrent_save_cannot_restore_over_a_successful_save(
    client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = tmp_path / "song.wav"
    write_wav(audio)
    song_id = import_song(client, audio)["songId"]
    failed, successful = tmp_path / "failed.mp4", tmp_path / "successful.mp4"
    failed.write_bytes(b"\x00\x00\x00\x18ftypfailed")
    successful.write_bytes(b"\x00\x00\x00\x18ftypsuccessful")
    updater = client.app.state.container.songs.update_song
    storage = updater._storage
    storage.copy_clip(song_id, successful)
    copied, contended, guard = Event(), Event(), Lock()
    acquire = storage._media_updates._locks.acquire
    original_copy = storage.copy_clip
    attempts = 0

    @contextmanager
    def observed_lock(key: str):
        nonlocal attempts
        with guard:
            attempts += 1
            if attempts > 1:
                contended.set()
        with acquire(key):
            yield

    def fail_after_copy(key: str, source: Path) -> Path:
        result = original_copy(key, source)
        if source == failed:
            copied.set()
            assert contended.wait(timeout=5), "second save did not contend"
            raise DependencyError("StorageUnavailable", "first save interrupted")
        return result

    monkeypatch.setattr(storage._media_updates._locks, "acquire", observed_lock)
    monkeypatch.setattr(storage, "copy_clip", fail_after_copy)
    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(updater.execute, song_id, UpdateSongRequest(video_path=failed))
        assert copied.wait(timeout=5)
        second = workers.submit(
            updater.execute, song_id, UpdateSongRequest(video_path=successful, title="Winner")
        )
        with pytest.raises(DependencyError, match="first save interrupted"):
            first.result(timeout=5)
        assert second.result(timeout=5).title == "Winner"

    assert client.get(f"/songs/{song_id}").json()["title"] == "Winner"
    assert client.get(f"/songs/{song_id}/clip").content == successful.read_bytes()
