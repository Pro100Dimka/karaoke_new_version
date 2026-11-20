from __future__ import annotations

import os
from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav
from tests.helpers import import_song

pytestmark = pytest.mark.integration


def _block_source_unlink(monkeypatch: pytest.MonkeyPatch, quarantine: Path) -> list[str]:
    unlink = os.unlink
    attempted: list[str] = []

    def locked(path, *args, **kwargs):
        if Path(path).name == "original.wav" and quarantine.is_dir():
            attempted.append(str(path))
            raise PermissionError("Song source is temporarily held by another process")
        return unlink(path, *args, **kwargs)

    # Leave shutil.rmtree itself real: its ignore_errors handling caused the lost retry.
    monkeypatch.setattr(os, "unlink", locked)
    return attempted


def test_delete_retains_cleanup_retry_when_rmtree_cannot_unlink_a_song_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    original = source.read_bytes()
    with monkeypatch.context() as locked:
        with app_client(root) as client:
            song_id = import_song(client, source)["songId"]
            operation = client.app.state.container.songs.delete_song
            quarantine = operation._storage.quarantine_path(song_id)
            attempted = _block_source_unlink(locked, quarantine)

            response = client.delete(f"/songs/{song_id}")

            assert response.status_code == 204, response.text
            assert client.get(f"/songs/{song_id}").status_code == 404
            assert attempted, "The real recursive remover did not reach the locked file"
            assert (quarantine / "source" / "original.wav").read_bytes() == original
            pending = operation._journal.entries()
            assert len(pending) == 1, "Unremoved song files must keep their cleanup journal"

        with app_client(root) as client:
            assert client.get(f"/songs/{song_id}").status_code == 404
            summary = client.app.state.container.startup_recovery
            assert summary.pending_transactions == 1
            assert summary.recovered_transactions == 0
            assert client.app.state.container.songs.delete_song._journal.entries() == pending

    with app_client(root) as client:
        summary = client.app.state.container.startup_recovery
        assert summary.pending_transactions == 0
        assert summary.recovered_transactions == 1
        assert client.get(f"/songs/{song_id}").status_code == 404
    assert not quarantine.exists()
    assert source.read_bytes() == original


def test_startup_retains_cleanup_retry_when_rmtree_cannot_unlink_a_deleted_song_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.125)
    original = source.read_bytes()
    with app_client(root) as client:
        song_id = import_song(client, source)["songId"]
        operation = client.app.state.container.songs.delete_song
        quarantine = operation._storage.quarantine_path(song_id)

        def interrupted(*_args):
            raise SystemExit("Interrupted after the metadata commit")

        with monkeypatch.context() as crash:
            crash.setattr(operation, "_finalize", interrupted)
            with pytest.raises(SystemExit):
                operation.execute(song_id)
        pending = operation._journal.entries()
        assert len(pending) == 1

    with monkeypatch.context() as locked:
        attempted = _block_source_unlink(locked, quarantine)
        with app_client(root) as client:
            assert client.get(f"/songs/{song_id}").status_code == 404
            assert attempted, "The real recursive remover did not reach the locked file"
            assert (quarantine / "source" / "original.wav").read_bytes() == original
            summary = client.app.state.container.startup_recovery
            assert summary.pending_transactions == 1, "Failed cleanup must not be called recovered"
            assert summary.recovered_transactions == 0
            assert client.app.state.container.songs.delete_song._journal.entries() == pending

    with app_client(root) as client:
        summary = client.app.state.container.startup_recovery
        assert summary.pending_transactions == 0
        assert summary.recovered_transactions == 1
    assert not quarantine.exists()
    assert source.read_bytes() == original
