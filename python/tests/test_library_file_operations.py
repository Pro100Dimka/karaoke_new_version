from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure.local_songs import LocalSongStorage
from backend.recordings.domain import Recording
from backend.storage.domain import StorageRoots


def test_selecting_the_current_managed_cover_keeps_it_usable(tmp_path: Path) -> None:
    storage = LocalSongStorage(StorageRoots.under(tmp_path / "library"))
    original = tmp_path / "cover.png"
    original.write_bytes(b"\x89PNG\r\n\x1a\noriginal-cover")
    managed = storage.copy_cover("song", original)

    selected = storage.copy_cover("song", managed)

    assert selected == managed
    assert selected.read_bytes() == original.read_bytes()


def test_failed_cover_copy_preserves_the_previously_selected_cover(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalSongStorage(StorageRoots.under(tmp_path / "library"))
    replacement = tmp_path / "cover.png"
    replacement.write_bytes(b"\x89PNG\r\n\x1a\noriginal-cover")
    managed = storage.copy_cover("song", replacement)
    original = managed.read_bytes()
    replacement.write_bytes(b"\x89PNG\r\n\x1a\nreplacement-cover")

    def fail_during_copy(source: Path, destination: Path) -> None:
        Path(destination).write_bytes(Path(source).read_bytes()[:5])
        raise OSError("Disk write interrupted")

    monkeypatch.setattr(shutil, "copyfile", fail_during_copy)

    with pytest.raises(DependencyError, match="custom cover"):
        storage.copy_cover("song", replacement)

    assert managed.read_bytes() == original
    assert tuple(managed.parent.iterdir()) == (managed,)


@pytest.mark.parametrize("remaining_sidecar", [False, True])
def test_recording_with_missing_media_can_be_deleted_from_the_library(
    client, tmp_path: Path, remaining_sidecar: bool
) -> None:
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    recording = Recording(target["recordingId"], path, 1, 16000, 1, datetime.now(UTC))
    with client.app.state.container.database.create() as transaction:
        transaction.recordings.add(recording)
        transaction.commit()
    if remaining_sidecar:
        (path.parent / "recording.wav.dry.wav").write_bytes(b"remaining source")
    else:
        shutil.rmtree(path.parent)

    deleted = client.delete(f"/recordings/{recording.recording_id}")

    assert deleted.status_code == 204, deleted.text
    assert client.get(f"/recordings/{recording.recording_id}").status_code == 404
    assert not path.parent.exists()
    assert not tuple((tmp_path / "runtime" / "recovery").glob("*.json"))
