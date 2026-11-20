from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.database import SqlUnitOfWork
from backend.infrastructure.recording_archive import RecordingArchive
from backend.infrastructure.recording_files import LocalRecordingStorage
from backend.songs.delete_song import DeleteSong
from tests.conftest import app_client, write_wav
from tests.helpers import import_song

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def no_background_audio_encoding(monkeypatch):
    monkeypatch.setattr(RecordingArchive, "_step", lambda archive: archive._cancel.wait(0.1))


def _recording(client, song_id=None):
    archive = client.app.state.container.recordings.archive
    if archive is not None:
        archive.stop()
    target = client.post("/recordings/target", json={"songId": song_id}).json()
    path = Path(target["filePath"])
    write_wav(path, seconds=0.125)
    response = client.post(
        "/recordings",
        json={
            **target,
            "duration": 0.125,
            "sampleRate": 16000,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song_id,
        },
    )
    assert response.status_code == 201, response.text
    return target["recordingId"], path


def _block_cleanup(monkeypatch, directory):
    remove = shutil.rmtree

    def locked(path, *args, **kwargs):
        if Path(path) == directory:
            raise PermissionError("Recording file is temporarily held by another process")
        return remove(path, *args, **kwargs)

    monkeypatch.setattr(shutil, "rmtree", locked)


def test_delete_acknowledges_commit_and_keeps_cleanup_journal_for_retry(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    with app_client(root) as client:
        identity, path = _recording(client)
        operation = client.app.state.container.recordings.delete
        quarantine = operation._storage.quarantine_path(identity, path)
        original = path.read_bytes()
        with monkeypatch.context() as locked:
            _block_cleanup(locked, quarantine.parent)
            response = client.delete(f"/recordings/{identity}")
            assert response.status_code == 204, response.text
            assert client.get(f"/recordings/{identity}").status_code == 404
            assert client.get("/recordings").json()["total"] == 0
            assert quarantine.read_bytes() == original
            assert not path.parent.exists()
            assert len(operation._journal.entries()) == 1

    with app_client(root) as client:
        assert client.get(f"/recordings/{identity}").status_code == 404
        assert client.app.state.container.startup_recovery.pending_transactions == 0
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
    assert not quarantine.parent.exists()


def test_startup_defers_cleanup_of_an_already_deleted_recording(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    with app_client(root) as client:
        identity, path = _recording(client)
        kept_id, kept = _recording(client)
        kept_audio = kept.read_bytes()
        operation = client.app.state.container.recordings.delete
        quarantine = operation._storage.quarantine_path(identity, path)

        def interrupted(_path):
            raise SystemExit("Crash after deletion was committed")

        with monkeypatch.context() as crash:
            crash.setattr(operation._storage, "finalize_quarantine", interrupted)
            with pytest.raises(SystemExit):
                operation.execute(identity)
        pending = operation._journal.entries()
        assert len(pending) == 1

    with monkeypatch.context() as locked:
        _block_cleanup(locked, quarantine.parent)
        with app_client(root) as client:
            assert client.get(f"/recordings/{identity}").status_code == 404
            assert client.get(f"/recordings/{kept_id}").status_code == 200
            assert kept.read_bytes() == kept_audio
            assert client.app.state.container.startup_recovery.pending_transactions == 1
            assert client.app.state.container.recordings.delete._journal.entries() == pending
            assert quarantine.is_file()

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.pending_transactions == 0
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
        assert client.get(f"/recordings/{kept_id}").status_code == 200
    assert not quarantine.parent.exists()


def test_failed_recording_delete_commit_restores_the_original_take(tmp_path, monkeypatch):
    with app_client(tmp_path / "runtime") as client:
        identity, path = _recording(client)
        original = path.read_bytes()
        operation = client.app.state.container.recordings.delete
        commit = SqlUnitOfWork.commit

        def failed(transaction):
            if identity in transaction.recordings.changed:
                raise DependencyError("DatabaseWriteFailed", "Injected commit failure")
            return commit(transaction)

        with monkeypatch.context() as failure:
            failure.setattr(SqlUnitOfWork, "commit", failed)
            response = client.delete(f"/recordings/{identity}")
        assert response.status_code == 503, response.text
        assert response.json()["code"] == "DatabaseWriteFailed"
        assert client.get(f"/recordings/{identity}").status_code == 200
        assert path.read_bytes() == original
        assert not operation._storage.quarantine_path(identity, path).parent.exists()
        assert operation._journal.entries() == ()


def test_startup_does_not_hide_a_failure_to_restore_a_kept_recording(tmp_path, monkeypatch):
    root = tmp_path / "runtime"
    with app_client(root) as client:
        identity, path = _recording(client)
        original = path.read_bytes()
        operation = client.app.state.container.recordings.delete
        move = operation._storage.quarantine

        def interrupted(*args):
            move(*args)
            raise SystemExit("Crash before metadata was deleted")

        with monkeypatch.context() as crash:
            crash.setattr(operation._storage, "quarantine", interrupted)
            with pytest.raises(SystemExit):
                operation.execute(identity)
        quarantine = operation._storage.quarantine_path(identity, path)

    def locked_restore(_storage, _quarantine, _target):
        raise PermissionError("Original recording cannot yet be restored")

    with monkeypatch.context() as locked:
        locked.setattr(LocalRecordingStorage, "restore_quarantine", locked_restore)
        with pytest.raises(PermissionError, match="cannot yet be restored"):
            with app_client(root):
                pytest.fail("Recovery cannot skip restoration of registered audio")
    assert quarantine.read_bytes() == original
    with app_client(root) as client:
        assert client.get(f"/recordings/{identity}").status_code == 200
        assert path.read_bytes() == original


@pytest.mark.parametrize("locked_area", ["song", "recording"])
def test_song_delete_defers_locked_cleanup_after_commit_and_during_startup(
    tmp_path, monkeypatch, locked_area
):
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    with monkeypatch.context() as locked:
        with app_client(root) as client:
            song_id = import_song(client, source)["songId"]
            identity, path = _recording(client, song_id)
            operation = client.app.state.container.songs.delete_song
            song_quarantine = operation._storage.quarantine_path(song_id)
            take_quarantine = operation._recordings.quarantine_path(identity, path).parent
            blocked = song_quarantine if locked_area == "song" else take_quarantine
            _block_cleanup(locked, blocked)
            response = client.delete(f"/songs/{song_id}")
            assert response.status_code == 204, response.text
            assert client.get(f"/songs/{song_id}").status_code == 404
            assert client.get(f"/recordings/{identity}").status_code == 404
            assert not path.parent.exists()
            assert blocked.is_dir()
            pending = operation._journal.entries()
            assert len(pending) == 1

        with app_client(root) as client:
            assert client.get(f"/songs/{song_id}").status_code == 404
            assert client.get(f"/recordings/{identity}").status_code == 404
            assert client.app.state.container.startup_recovery.pending_transactions == 1
            assert client.app.state.container.songs.delete_song._journal.entries() == pending
            assert blocked.is_dir()

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.pending_transactions == 0
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
    assert not song_quarantine.exists()
    assert not take_quarantine.exists()


def test_song_delete_failure_before_commit_restores_song_and_associated_take(tmp_path, monkeypatch):
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    with app_client(tmp_path / "runtime") as client:
        song_id = import_song(client, source)["songId"]
        identity, path = _recording(client, song_id)
        operation = client.app.state.container.songs.delete_song
        original = path.read_bytes()
        song_path = client.app.state.container.roots.songs / song_id
        song_files = {
            file.relative_to(song_path): file.read_bytes()
            for file in song_path.rglob("*")
            if file.is_file()
        }

        def failed(_operation, _song_id):
            raise DependencyError("DatabaseWriteFailed", "Injected commit failure")

        with monkeypatch.context() as failure:
            failure.setattr(DeleteSong, "_delete_metadata", failed)
            response = client.delete(f"/songs/{song_id}")
        assert response.status_code == 503, response.text
        assert response.json()["code"] == "DatabaseWriteFailed"
        assert client.get(f"/songs/{song_id}").status_code == 200
        assert client.get(f"/recordings/{identity}").status_code == 200
        assert path.read_bytes() == original
        assert {
            file.relative_to(song_path): file.read_bytes()
            for file in song_path.rglob("*")
            if file.is_file()
        } == song_files
        assert operation._journal.entries() == ()


@pytest.mark.parametrize("locked_area", ["song", "recording"])
def test_song_delete_startup_defers_cleanup_after_interrupted_commit(
    tmp_path, monkeypatch, locked_area
):
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    with app_client(root) as client:
        song_id = import_song(client, source)["songId"]
        identity, path = _recording(client, song_id)
        operation = client.app.state.container.songs.delete_song
        storage = operation._storage if locked_area == "song" else operation._recordings
        blocked = (
            operation._storage.quarantine_path(song_id)
            if locked_area == "song"
            else operation._recordings.quarantine_path(identity, path).parent
        )

        def interrupted(_path):
            raise SystemExit("Crash after song deletion was committed")

        with monkeypatch.context() as crash:
            crash.setattr(storage, "finalize_quarantine", interrupted)
            with pytest.raises(SystemExit):
                operation.execute(song_id)
        pending = operation._journal.entries()
        assert len(pending) == 1

    with monkeypatch.context() as locked:
        _block_cleanup(locked, blocked)
        with app_client(root) as client:
            assert client.get(f"/songs/{song_id}").status_code == 404
            assert client.get(f"/recordings/{identity}").status_code == 404
            assert client.app.state.container.startup_recovery.pending_transactions == 1
            assert client.app.state.container.songs.delete_song._journal.entries() == pending
            assert blocked.is_dir()

    with app_client(root) as client:
        assert client.app.state.container.startup_recovery.pending_transactions == 0
        assert client.app.state.container.startup_recovery.recovered_transactions == 1
    assert not blocked.exists()
