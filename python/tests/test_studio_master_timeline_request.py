from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_recordings_analysis import ready_song


pytestmark = pytest.mark.integration
_RATE = 44_100
_FRAMES = _RATE * 2


def _capture_metadata():
    # A paused take can receive several state changes without recording another frame.
    states = (
        (0, 0, 1, 0),
        (0.6, 0.6, 0.9, 1),
        (0.6, 0.6, 1.1, 2),
        (0.6 + 0.2 / _RATE, 0.6, 1, 0),
        (2, 20, 1, 0),
        (2.01, 30, 0.8, -1),
    )
    return {
        "captureSession": "pause-and-stop-timeline",
        "playbackAdjustments": [
            dict(zip(("elapsedSeconds", "sourceSeconds", "playbackRate", "keyShift"), state))
            for state in states
        ],
        "nativeRecording": {"durationFrames": _FRAMES, "sampleRate": _RATE, "channels": 1},
    }


def _register_take(client, song, metadata):
    response = client.post("/recordings/target")
    assert response.status_code == 200, response.text
    target = response.json()
    path = Path(target["filePath"])
    axis = np.arange(_FRAMES) / _RATE
    vocal = 0.08 * np.sin(2 * np.pi * 440 * axis) * (0.6 + 0.4 * np.sin(np.pi * axis) ** 2)
    backing = 0.04 * np.sin(2 * np.pi * 220 * axis)
    sf.write(path, vocal + backing, _RATE, subtype="PCM_24")
    for suffix, samples in ((".dry.wav", vocal), (".vocal.wav", vocal), (".backing.wav", backing)):
        sf.write(Path(str(path) + suffix), samples, _RATE, subtype="FLOAT")
    registered = client.post(
        "/recordings",
        json={
            **target,
            "duration": _FRAMES / _RATE,
            "sampleRate": _RATE,
            "channels": 1,
            "createdAt": datetime.now(UTC).isoformat(),
            "songId": song["songId"],
            "songRevision": song["activeRevision"],
            "gaps": [],
            "sessionMetadata": metadata,
        },
    )
    assert registered.status_code == 201, registered.text
    assert registered.json()["fileStatus"] == "Ready"
    return target["recordingId"]


def _verify_master(client, job, original_id, metadata):
    master_id = job["report"]["recordingId"]
    master = client.get(f"/recordings/{master_id}").json()
    assert master_id != original_id and master["sourceRecordingId"] == original_id
    samples, rate = sf.read(master["filePath"], dtype="float32", always_2d=True)
    assert rate == _RATE and samples.shape == (_FRAMES, 1)
    assert np.isfinite(samples).all() and float(np.max(np.abs(samples))) > 0.01
    processing = job["report"]["balance"]["processing"]
    assert processing["referenceValidIntervals"] == [[0, 2]]
    assert processing["referenceCoverage"] == pytest.approx(1)
    assert processing["synchronization"] == "native-playback-timeline"
    assert processing["vocalSource"] == "dry" and processing["vocalChain"]
    assert processing["stageSeconds"]["vocalInserts"] > 0
    assert processing["qualityControl"]["verified"] and "bypassReason" not in processing
    assert processing["playbackAdjustments"] == metadata["playbackAdjustments"]
    original = client.app.state.container.recordings.get.execute(original_id)
    assert original.session_metadata == metadata


def test_studio_master_request_preserves_take_with_same_frame_and_trailing_states(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source, seconds=4, frequency=220)
    provider = FakeAiProvider()
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        song = ready_song(client, source)

        def unexpected_separation(*args, **kwargs):
            pytest.fail("AD Master must use the synchronized recorded stems")

        monkeypatch.setattr(provider, "separate", unexpected_separation)
        metadata = _capture_metadata()
        original_id = _register_take(client, song, metadata)
        started = client.post(f"/recordings/{original_id}/studio-master")
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"], timeout=30)
        assert job["state"] == "Succeeded", job
        _verify_master(client, job, original_id, metadata)
