from __future__ import annotations

import json
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from threading import Lock
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import NotFoundError
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.recording_archive import RecordingArchive
from backend.recordings.domain import Recording
from backend.recordings.start_studio_master import StartStudioMaster
from backend.recordings.studio_audio import recording_stems
from tests.conftest import app_client, write_wav
from tests.helpers import import_song
from tests.test_library_archive import transfer
from tests.test_recording_sources import _take


def _register_original(client, song):
    allocated = client.post("/recordings/target", json={"songId": song["songId"]})
    assert allocated.status_code == 200, allocated.text
    target = allocated.json()
    mix, dry, vocal, backing = _take(Path(target["filePath"]).parent, frames=96_000)
    info = sf.info(mix)
    response = client.post(
        "/recordings",
        json={
            **target,
            "duration": info.duration,
            "sampleRate": info.samplerate,
            "channels": info.channels,
            "createdAt": "2026-11-20T10:00:00+00:00",
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
            "gaps": [{"startSeconds": 0.25, "durationSeconds": 0.01}],
            "sessionMetadata": {
                "captureSession": "compact-lifecycle",
                "playbackAdjustments": [
                    {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1.1, "keyShift": 2}
                ],
            },
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["fileStatus"] == "Ready"
    renamed = client.patch(
        f"/recordings/{target['recordingId']}", json={"displayName": "Мой дубль"}
    )
    assert renamed.status_code == 200, renamed.text
    original = client.app.state.container.recordings.get.execute(target["recordingId"])
    return (
        original,
        sf.read(dry, dtype="float32")[0],
        {path.name: sha256_file(path) for path in (vocal, backing)},
    )


def _publish_master(client, original, work: Path):
    samples, rate = sf.read(original.file_path, dtype="float32")
    rendered = work / "finished-master.wav"
    sf.write(rendered, samples * 0.25, rate, subtype="PCM_24")
    publisher = client.app.state.container.recordings.start_studio_master._publisher
    master = publisher.execute(original, rendered, {"qualityControl": {"verified": True}})
    renamed = client.patch(
        f"/recordings/{master.recording_id}", json={"displayName": "Мой AD Master"}
    )
    assert renamed.status_code == 200, renamed.text
    return client.app.state.container.recordings.get.execute(master.recording_id)


def _history(client):
    with client.app.state.container.database.create() as transaction:
        return tuple(
            transaction.history.list(limit=100, offset=0, event_types=("RecordingRegistered",))
        )


def _verify_rows_and_audio(client, expected):
    current = []
    for previous in expected:
        recording = client.app.state.container.recordings.get.execute(previous.recording_id)
        assert replace(recording, file_path=previous.file_path) == previous
        assert recording.file_path.suffix == ".mp3"
        audio = sf.info(recording.file_path)
        assert (audio.format, audio.frames, audio.samplerate, audio.channels) == (
            "MP3",
            round(previous.duration * previous.sample_rate),
            previous.sample_rate,
            previous.channels,
        )
        cache = json.loads(Path(str(recording.file_path) + ".peaks.json").read_text())
        assert cache["sha256"] == sha256_file(recording.file_path)
        assert cache["size"] == recording.file_path.stat().st_size
        assert len(cache["peaks"]) == 4096
        response = client.get(f"/recordings/{recording.recording_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["filePath"] == str(recording.file_path)
        assert payload["displayName"] == previous.display_name
        assert payload["sizeBytes"] == recording.file_path.stat().st_size
        current.append(recording)
    master = client.get(f"/recordings/{current[1].recording_id}").json()
    assert master["sourceRecordingId"] == current[0].recording_id
    return current


def _recording_hashes(root: Path):
    return {
        path.relative_to(root): sha256_file(path)
        for path in (root / "recordings").rglob("recording*")
        if path.is_file()
    }


def _hold_archive_scheduling(archive):
    # Permit real shutdown/join without ever running the worker's archive step.
    archive._loop._stopping.set()
    archive._loop.start()


@pytest.mark.integration
def test_compact_recordings_keep_sources_metadata_and_library_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(RecordingArchive, "start", _hold_archive_scheduling)
    source_root, restored_root = tmp_path / "source", tmp_path / "restored"
    song_file = tmp_path / "unprocessed-song.wav"
    write_wav(song_file, seconds=2)
    with app_client(source_root) as client:
        song = import_song(client, song_file)
        original, dry_samples, retained = _register_original(client, song)
        master = _publish_master(client, original, tmp_path)
        history = _history(client)
        assert {event.entity_id for event in history} == {
            original.recording_id,
            master.recording_id,
        }
        archive = client.app.state.container.recordings.archive
        assert len(archive._pending) == 2, "real Ready callbacks queue each recording independently"
        for marker in tuple(archive._pending):
            archive._archive_one(marker)
        assert not archive._pending
        archived = _verify_rows_and_audio(client, (original, master))
        assert not original.file_path.exists() and not master.file_path.exists()
        dry = original.file_path.parent / "recording.wav.dry.flac"
        np.testing.assert_array_equal(
            sf.read(dry, dtype="float32")[0].view(np.uint32), dry_samples.view(np.uint32)
        )
        assert not dry.with_suffix(".wav").exists()
        assert recording_stems(archived[0].file_path, prefer_dry=True)[0] == dry
        assert {name: sha256_file(dry.parent / name) for name in retained} == retained
        assert _history(client) == history
        hashes = _recording_hashes(source_root)
        bundle = Path(transfer(client, "export")["path"])
    with app_client(restored_root) as client:
        assert transfer(client, "import", bundle) == {
            "imported": 1,
            "skipped": 0,
            "recordingsAdded": 2,
            "recordingsSkipped": 0,
        }
        _verify_rows_and_audio(client, archived)
        assert _recording_hashes(restored_root) == hashes
        assert _history(client) == history
        assert client.get("/recordings").json()["total"] == 2


@pytest.mark.parametrize("switch_at", ["after-row-read", "job-submission"])
def test_master_admission_tolerates_archival_without_prejob_stem_io(tmp_path, switch_at):
    original, compact = tmp_path / "recording.wav", tmp_path / "recording.mp3"
    original.write_bytes(b"finalized original")
    compact.write_bytes(b"verified compact copy")
    current = Recording("take", original, 1, 48000, 2, datetime.now(UTC), "song", 1)
    submitted = []

    def switch_path():
        nonlocal current
        current = replace(current, file_path=compact)
        original.unlink(missing_ok=True)

    def get(recording_id):
        previous = current
        if switch_at == "after-row-read":
            switch_path()
        return previous

    @contextmanager
    def transaction():
        yield SimpleNamespace(recordings=SimpleNamespace(get=get))

    def submit(*args, **kwargs):
        if switch_at == "job-submission":
            switch_path()
        submitted.append(kwargs["entity_id"])
        return "submitted"

    service = StartStudioMaster.__new__(StartStudioMaster)
    service._uow = SimpleNamespace(create=transaction)
    service._projects = SimpleNamespace(artifact_path=lambda *args: compact)
    service._jobs = SimpleNamespace(
        start=submit, prepare_submission=nullcontext, list=lambda **_: ()
    )
    service._submission_lock = Lock()
    service._stems = lambda recording: pytest.fail("Stem I/O must run after job admission")
    assert service.execute("take") == "submitted"
    assert submitted == ["take"]
    assert service._recording("take").file_path == compact
    compact.unlink()
    with pytest.raises(NotFoundError, match="unavailable"):
        service.execute("take")
    assert submitted == ["take"], "missing media still fails before queuing a job"
