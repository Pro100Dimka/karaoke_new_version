from __future__ import annotations

import os
import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote

import pytest

from backend.infrastructure import recording_files
from backend.domain_errors import DomainError
from backend.recordings.domain import Recording
from backend.storage.domain import StorageRoots
from tests.conftest import write_wav


@pytest.mark.parametrize("content", ["audio", "empty", "missing"])
def test_one_recording_recovery_does_not_scan_neighboring_recordings(client, monkeypatch, content):
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    root = path.parent.parent
    descriptor = path.parent / "recording-recovery.json"
    for index in range(1500):
        (root / f"unrelated-{index:04}").mkdir()
    if content == "missing":
        descriptor.unlink()
    else:
        write_wav(path, seconds=0.125 if content == "audio" else 0)
    original = path.read_bytes() if path.exists() else None
    # Exercise real discovery, repair and registration. The exclusive Windows
    # handle is a platform boundary, covered by the existing Windows recovery tests.
    if os.name != "nt":
        monkeypatch.setattr(
            recording_files, "_open_stopped_recording", lambda file: file.open("r+b")
        )
    scandir = os.scandir
    scanned = []

    def observe_scandir(directory):
        if not isinstance(directory, int):
            candidate = Path(directory)
            if candidate == root or root in candidate.parents:
                scanned.append(candidate)
        return scandir(directory)

    with monkeypatch.context() as lookup:
        lookup.setattr(os, "scandir", observe_scandir)
        response = client.post(f"/recordings/{target['recordingId']}/recover")
    assert response.status_code == 204, response.text
    recording = client.get(f"/recordings/{target['recordingId']}")
    if content == "audio":
        assert recording.status_code == 200, recording.text
        assert recording.json()["fileStatus"] == "RecoveredIncomplete"
        assert path.read_bytes() == original
        assert not descriptor.exists()
    else:
        assert recording.status_code == 404, recording.text
        assert path.parent.exists() is (content == "missing")
    assert len(scanned) <= 1, f"Recovering one known ID scanned {len(scanned)} directories"
    assert all(directory == path.parent for directory in scanned)


def _orphan(storage, recording_id, filename="recording.wav", *, seconds=0):
    allocated = storage.allocate_target(recording_id, ".wav")
    path = allocated.with_name(filename)
    write_wav(path, seconds=seconds)
    descriptor = storage.write_recovery_descriptor(
        Recording(recording_id, path, 0, 0, 0, datetime.now(UTC))
    )
    return path, descriptor


def test_targeted_recovery_treats_a_valid_id_as_a_literal_directory(client):
    storage = client.app.state.container.recordings.reconcile._storage
    selected, descriptor = _orphan(storage, "take[1]")
    neighbor, neighbor_descriptor = _orphan(storage, "take1")
    before = neighbor_descriptor.read_bytes()

    response = client.post(f"/recordings/{quote('take[1]')}/recover")

    assert response.status_code == 204, response.text
    assert not selected.parent.exists() and not descriptor.exists()
    assert neighbor.exists() and neighbor_descriptor.read_bytes() == before


def test_full_reconciliation_still_discovers_all_recordings_and_defers_corrupt_entries(client):
    reconcile = client.app.state.container.recordings.reconcile
    first, _ = _orphan(reconcile._storage, "first")
    second, _ = _orphan(reconcile._storage, "second")
    corrupt, descriptor = _orphan(reconcile._storage, "corrupt", seconds=0.125)
    descriptor.write_text("invalid JSON", encoding="utf-8")
    original = corrupt.read_bytes()

    assert reconcile.execute() == ()

    assert not first.parent.exists() and not second.parent.exists()
    assert corrupt.read_bytes() == original
    assert descriptor.read_text(encoding="utf-8") == "invalid JSON"


@pytest.mark.parametrize("kind", ["invalid-json", "directory"])
def test_targeted_recovery_preserves_descriptor_errors(client, kind):
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    write_wav(path, seconds=0.125)
    original = path.read_bytes()
    descriptor = path.parent / "recording-recovery.json"
    if kind == "directory":
        descriptor.unlink()
        descriptor.mkdir()
    else:
        descriptor.write_text("invalid JSON", encoding="utf-8")

    response = client.post(f"/recordings/{target['recordingId']}/recover")

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "RecordingRecoveryInvalid"
    assert path.read_bytes() == original
    assert descriptor.exists()


def test_targeted_recovery_uses_the_owned_audio_path_in_a_legacy_descriptor(client, monkeypatch):
    storage = client.app.state.container.recordings.reconcile._storage
    path, descriptor = _orphan(storage, "legacy-take", "capture-balanced.wav", seconds=0.125)
    original = path.read_bytes()
    if os.name != "nt":
        monkeypatch.setattr(
            recording_files, "_open_stopped_recording", lambda file: file.open("r+b")
        )

    response = client.post("/recordings/legacy-take/recover")

    assert response.status_code == 204, response.text
    recovered = client.get("/recordings/legacy-take")
    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["filePath"] == str(path)
    assert recovered.json()["fileStatus"] == "RecoveredIncomplete"
    assert path.read_bytes() == original and not descriptor.exists()


@pytest.mark.parametrize("recording_id", ["../escape", "..\\escape", "C:\\outside", ".", ""])
def test_targeted_descriptor_lookup_rejects_ids_outside_the_owned_directory(tmp_path, recording_id):
    storage = recording_files.LocalRecordingStorage(StorageRoots.under(tmp_path))
    with pytest.raises(DomainError) as invalid:
        storage.recovery_descriptors(recording_id)
    assert invalid.value.code == "InvalidRecording"


def test_targeted_recovery_does_not_modify_audio_outside_its_storage(client, tmp_path):
    target = client.post("/recordings/target").json()
    path = Path(target["filePath"])
    outside = tmp_path / "outside.wav"
    write_wav(path, seconds=0.125)
    write_wav(outside, seconds=0.25)
    descriptor = path.parent / "recording-recovery.json"
    metadata = json.loads(descriptor.read_text(encoding="utf-8"))
    metadata["filePath"] = str(outside)
    descriptor.write_text(json.dumps(metadata), encoding="utf-8")
    original = {file: file.read_bytes() for file in (path, outside, descriptor)}

    response = client.post(f"/recordings/{target['recordingId']}/recover")

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "PathOutsideAllowedRoot"
    assert {file: file.read_bytes() for file in original} == original
    assert client.get(f"/recordings/{target['recordingId']}").status_code == 404
