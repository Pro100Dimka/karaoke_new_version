from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Lock

import pytest
from fastapi.testclient import TestClient

from tests.conftest import write_wav
from tests.helpers import import_song


def _song_and_media(client: TestClient, tmp_path: Path, field: str) -> tuple[str, Path, Path]:
    audio = tmp_path / "song.wav"
    write_wav(audio)
    song_id = import_song(client, audio)["songId"]
    source = tmp_path / ("cover.png" if field == "coverPath" else "video.mp4")
    source.write_bytes(b"custom-cover" if field == "coverPath" else b"\x00\x00\x00\x18ftypvideo")
    return f"/songs/{song_id}", tmp_path / "runtime" / "songs" / str(song_id), source


@pytest.fixture
def contender_progress(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Event:
    """Release the first request when the second either finishes or waits on its media lock."""
    progressed, guard = Event(), Lock()
    held: set[str] = set()
    locks = client.app.state.container.songs.update_song._storage._media_updates._locks
    acquire = locks.acquire

    @contextmanager
    def observed_acquire(song_id: str):
        with guard:
            if song_id in held:
                progressed.set()
        with acquire(song_id):
            with guard:
                held.add(song_id)
            try:
                yield
            finally:
                with guard:
                    held.remove(song_id)

    monkeypatch.setattr(locks, "acquire", observed_acquire)
    return progressed


@pytest.mark.parametrize("field", ["coverPath", "videoPath"])
def test_media_update_cannot_recreate_a_song_directory_during_deletion(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    contender_progress: Event,
    field: str,
) -> None:
    endpoint, directory, source = _song_and_media(client, tmp_path, field)
    deleter = client.app.state.container.songs.delete_song
    delete_metadata = deleter._delete_metadata
    quarantined, release = Event(), Event()

    def paused_delete_metadata(song_id: str) -> None:
        quarantined.set()
        assert release.wait(timeout=10), "The concurrent media update did not start"
        delete_metadata(song_id)

    monkeypatch.setattr(deleter, "_delete_metadata", paused_delete_metadata)
    with ThreadPoolExecutor(max_workers=2) as workers:
        deleting = workers.submit(client.delete, endpoint)
        try:
            assert quarantined.wait(timeout=10), "Deletion did not quarantine the song"
            updating = workers.submit(client.patch, endpoint, json={field: str(source)})
            updating.add_done_callback(lambda _future: contender_progress.set())
            assert contender_progress.wait(timeout=10), "The media update did not progress"
        finally:
            release.set()
        deleted = deleting.result(timeout=10)
        updated = updating.result(timeout=10)

    assert deleted.status_code == 204, deleted.text
    assert not directory.exists(), "Successful deletion left newly published song media behind"
    assert updated.status_code == 404, updated.text
    assert updated.json()["code"] == "SongNotFound"
    assert client.get(endpoint).status_code == 404
    assert source.is_file()


@pytest.mark.parametrize(
    "field,copy_method", [("coverPath", "copy_cover"), ("videoPath", "copy_clip")]
)
def test_deletion_waits_for_an_in_progress_media_update(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    contender_progress: Event,
    field: str,
    copy_method: str,
) -> None:
    endpoint, directory, source = _song_and_media(client, tmp_path, field)
    storage = client.app.state.container.songs.update_song._storage
    copy = getattr(storage, copy_method)
    copying, release = Event(), Event()

    def paused_copy(song_id: str, path: Path) -> Path:
        copying.set()
        assert release.wait(timeout=10), "The concurrent deletion did not start"
        return copy(song_id, path)

    monkeypatch.setattr(storage, copy_method, paused_copy)
    with ThreadPoolExecutor(max_workers=2) as workers:
        updating = workers.submit(client.patch, endpoint, json={field: str(source)})
        try:
            assert copying.wait(timeout=10), "The media update did not start copying"
            deleting = workers.submit(client.delete, endpoint)
            deleting.add_done_callback(lambda _future: contender_progress.set())
            assert contender_progress.wait(timeout=10), "Deletion did not progress"
        finally:
            release.set()
        updated = updating.result(timeout=10)
        deleted = deleting.result(timeout=10)

    assert updated.status_code == 200, updated.text
    assert deleted.status_code == 204, deleted.text
    assert client.get(endpoint).status_code == 404
    assert not directory.exists()
    assert source.is_file()
