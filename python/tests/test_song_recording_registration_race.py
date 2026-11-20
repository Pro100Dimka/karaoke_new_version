from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, wait
from datetime import UTC, datetime
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient

from backend.domain_errors import DependencyError
from tests.conftest import write_wav
from tests.helpers import import_song


def _song_and_recording(
    client: TestClient, tmp_path: Path, *, related: bool = True
) -> tuple[str, dict[str, object], Path]:
    source = tmp_path / "song.wav"
    write_wav(source)
    song = import_song(client, source)
    context = {"songId": song["songId"], "songRevision": song["activeRevision"]} if related else {}
    response = client.post("/recordings/target", json=context)
    assert response.status_code == 200, response.text
    target = response.json()
    audio = Path(target["filePath"])
    write_wav(audio)
    return (
        f"/songs/{song['songId']}",
        {
            **target,
            **context,
            "duration": 1.0,
            "sampleRate": 16_000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
        },
        audio,
    )


@pytest.mark.parametrize(
    "method,related",
    [
        ("recovery_descriptors", True),
        ("read_recovery_descriptor", True),
        ("read_recovery_descriptor", False),
    ],
)
def test_registration_cannot_change_recovery_descriptors_during_song_deletion(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    method: str,
    related: bool,
) -> None:
    endpoint, payload, audio = _song_and_recording(client, tmp_path, related=related)
    original_audio = audio.read_bytes()
    storage = client.app.state.container.songs.delete_song._recordings
    original = getattr(storage, method)
    entered, release = Event(), Event()

    def paused(*args):
        entered.set()
        assert release.wait(timeout=10), "The concurrent registration did not start"
        return original(*args)

    monkeypatch.setattr(storage, method, paused)
    with ThreadPoolExecutor(max_workers=2) as workers:
        deleting = workers.submit(client.delete, endpoint)
        try:
            assert entered.wait(timeout=10), "Deletion did not inspect recovery descriptors"
            registering = workers.submit(client.post, "/recordings", json=payload)
            wait((registering,), timeout=1)
        finally:
            release.set()
        deleted = deleting.result(timeout=10)
        registered = registering.result(timeout=10)

    assert deleted.status_code == 204, deleted.text
    assert client.get(endpoint).status_code == 404
    assert registered.status_code == (404 if related else 201), registered.text
    saved = client.get(f"/recordings/{payload['recordingId']}")
    assert saved.status_code == (404 if related else 200), saved.text
    if related:
        assert not audio.parent.exists(), "Deleted song left an orphan recording behind"
    else:
        assert registered.json()["fileStatus"] == "Ready"
        assert audio.read_bytes() == original_audio
        assert not (audio.parent / "recording-recovery.json").exists()


def test_song_deletion_waits_for_registration_to_commit_and_remove_its_descriptor(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, payload, audio = _song_and_recording(client, tmp_path)
    register = client.app.state.container.recordings.register
    persist = register._persist
    entered, release = Event(), Event()

    def paused_persist(*args):
        entered.set()
        assert release.wait(timeout=10), "The concurrent deletion did not start"
        return persist(*args)

    monkeypatch.setattr(register, "_persist", paused_persist)
    with ThreadPoolExecutor(max_workers=2) as workers:
        registering = workers.submit(client.post, "/recordings", json=payload)
        try:
            assert entered.wait(timeout=10), "Registration did not reach persistence"
            deleting = workers.submit(client.delete, endpoint)
            wait((deleting,), timeout=1)
        finally:
            release.set()
        registered = registering.result(timeout=10)
        deleted = deleting.result(timeout=10)

    assert registered.status_code == 201, registered.text
    assert registered.json()["fileStatus"] == "Ready"
    assert deleted.status_code == 204, deleted.text
    assert client.get(endpoint).status_code == 404
    saved = client.get(f"/recordings/{payload['recordingId']}")
    assert saved.status_code == 404, "Registration recreated metadata after song deletion"
    assert not audio.parent.exists()


def test_failed_registration_releases_song_deletion(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, payload, audio = _song_and_recording(client, tmp_path)
    original_audio = audio.read_bytes()
    register = client.app.state.container.recordings.register

    def fail_persist(*_args):
        raise DependencyError("DatabaseWriteFailed", "Recording commit interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(register, "_persist", fail_persist)
        registered = client.post("/recordings", json=payload)

    assert registered.status_code == 503, registered.text
    assert audio.read_bytes() == original_audio
    assert (audio.parent / "recording-recovery.json").is_file()
    assert client.delete(endpoint).status_code == 204
    assert client.get(f"/recordings/{payload['recordingId']}").status_code == 404
    assert not audio.parent.exists()


def test_failed_song_deletion_restores_capture_and_releases_registration(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, payload, audio = _song_and_recording(client, tmp_path)
    original_audio = audio.read_bytes()
    deleter = client.app.state.container.songs.delete_song

    def fail_delete(*_args):
        raise DependencyError("DatabaseWriteFailed", "Song deletion interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(deleter, "_delete_metadata", fail_delete)
        deleted = client.delete(endpoint)

    assert deleted.status_code == 503, deleted.text
    assert client.get(endpoint).status_code == 200
    assert audio.read_bytes() == original_audio
    assert (audio.parent / "recording-recovery.json").is_file()
    registered = client.post("/recordings", json=payload)
    assert registered.status_code == 201, registered.text
    assert registered.json()["fileStatus"] == "Ready"
    assert audio.read_bytes() == original_audio
    assert not (audio.parent / "recording-recovery.json").exists()
    assert client.delete(endpoint).status_code == 204
    assert not audio.parent.exists()


def test_pending_song_deletion_precedes_a_later_unrelated_registration(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    endpoint, payload, audio = _song_and_recording(client, tmp_path)
    target = client.post("/recordings/target").json()
    later_audio = Path(target["filePath"])
    write_wav(later_audio)
    later_payload = {**payload, **target, "songId": None, "songRevision": None}
    register = client.app.state.container.recordings.register
    deleter = client.app.state.container.songs.delete_song
    persist, delete_metadata = register._persist, deleter._delete_metadata
    entered, release, delete_waiting, later_progress = Event(), Event(), Event(), Event()
    order: list[str] = []
    condition = register._lifecycle._condition
    wait_for_change = condition.wait

    def observed_wait(timeout=None):
        if delete_waiting.is_set():
            later_progress.set()
        else:
            delete_waiting.set()
        return wait_for_change(timeout)

    def paused_persist(recording, *args):
        if recording.recording_id == payload["recordingId"]:
            entered.set()
            assert release.wait(timeout=10), "Later registration did not start"
        else:
            order.append("later registration")
            later_progress.set()
        return persist(recording, *args)

    def observed_delete(song_id):
        order.append("deletion")
        return delete_metadata(song_id)

    monkeypatch.setattr(condition, "wait", observed_wait)
    monkeypatch.setattr(register, "_persist", paused_persist)
    monkeypatch.setattr(deleter, "_delete_metadata", observed_delete)
    with ThreadPoolExecutor(max_workers=3) as workers:
        first = workers.submit(client.post, "/recordings", json=payload)
        try:
            assert entered.wait(timeout=10), "First registration did not reach persistence"
            deleting = workers.submit(client.delete, endpoint)
            assert delete_waiting.wait(timeout=10), "Deletion did not wait for registration"
            later = workers.submit(client.post, "/recordings", json=later_payload)
            later.add_done_callback(lambda _future: later_progress.set())
            assert later_progress.wait(timeout=10), "Later registration did not progress"
        finally:
            release.set()
        registered, deleted, later_registered = (
            first.result(timeout=10),
            deleting.result(timeout=10),
            later.result(timeout=10),
        )

    assert registered.status_code == 201, registered.text
    assert deleted.status_code == 204, deleted.text
    assert later_registered.status_code == 201, later_registered.text
    assert order == ["deletion", "later registration"]
    assert client.get(f"/recordings/{payload['recordingId']}").status_code == 404
    assert not audio.parent.exists()
    assert client.get(f"/recordings/{target['recordingId']}").status_code == 200
    assert later_audio.is_file()
    assert not (later_audio.parent / "recording-recovery.json").exists()
