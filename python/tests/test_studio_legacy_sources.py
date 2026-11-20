from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.ai.domain import AiCapability
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.recording_archive import RecordingArchive
from backend.recordings.studio_audio import recording_stems
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_recordings_analysis import ready_song, register_recording


def _legacy_take(root, suffix, *, original=False):
    rate = 16000
    axis = np.arange(3200) / rate
    backing = 0.04 * np.sin(2 * np.pi * 220 * axis)
    mixed = backing + 0.1 * np.sin(2 * np.pi * 440 * axis)
    path = root / f"recording{suffix}"
    paired = root / "recording.wav.backing.wav"
    if suffix == ".mp3":
        sf.write(path, mixed * 0.4, rate, format="MP3")
    else:
        sf.write(path, mixed * (0.4 if original else 1), rate, subtype="PCM_24")
    sf.write(paired, backing, rate, subtype="PCM_24")
    source = path
    if original:
        source = root / "recording.original.wav"
        sf.write(source, mixed, rate, subtype="PCM_24")
    return path, source, paired


@pytest.mark.parametrize("suffix, original", [
    (".wav", False), (".wav", True), (".flac", False), (".flac", True), (".mp3", True),
])
def test_legacy_recovery_uses_actual_lossless_audio_and_native_companion_names(
    tmp_path, suffix, original
):
    path, source, backing = _legacy_take(tmp_path, suffix, original=original)
    preserved = {item: item.read_bytes() for item in {path, source, backing}}
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    renderer.preserve_stems(path)
    stems = recording_stems(path, prefer_dry=True)
    assert stems is not None, "lossless archival must not require neural source separation"
    vocal, paired = stems
    assert vocal == tmp_path / "recording.wav.vocal.wav"
    assert paired == backing
    expected = sf.read(source, dtype="float32")[0] - sf.read(backing, dtype="float32")[0]
    actual, rate = sf.read(vocal, dtype="float32")
    np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-7)
    assert rate == 16000 and len(actual) == 3200
    assert {item: item.read_bytes() for item in preserved} == preserved
    encoded = vocal.read_bytes()
    renderer.preserve_stems(path)
    assert vocal.read_bytes() == encoded, "repeat use must not recover a stem again"


@pytest.mark.parametrize("suffix", [".wav", ".mp3"])
def test_legacy_recovery_does_not_subtract_from_lossy_audio_even_with_a_wav_name(tmp_path, suffix):
    path = tmp_path / f"recording{suffix}"
    samples = np.sin(np.arange(3200) * 0.15).astype(np.float32) * 0.1
    sf.write(path, samples, 16000, format="MP3")
    backing = tmp_path / "recording.wav.backing.wav"
    sf.write(backing, samples * 0.2, 16000, subtype="PCM_24")
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    renderer.preserve_stems(path)
    assert not (tmp_path / "recording.wav.vocal.wav").exists()
    assert not (tmp_path / "recording.mp3.vocal.wav").exists()
    assert recording_stems(path) is None


def test_archived_legacy_take_can_create_ad_master_without_a_separation_provider(tmp_path, monkeypatch):
    # Run the real archive deterministically after creating the historical backing-only layout.
    monkeypatch.setattr(RecordingArchive, "_step", lambda self: self._cancel.wait(0.05))
    source = tmp_path / "song.wav"
    write_wav(source)
    provider = FakeAiProvider()
    with app_client(tmp_path / "runtime", ai_providers=(provider,)) as client:
        song = ready_song(client, source)
        take = register_recording(client, song, session_metadata={"playbackAdjustments": [
            {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0},
        ]})
        path = Path(take["filePath"])
        backing = Path(str(path) + ".backing.wav")
        write_wav(backing, frequency=220)
        expected = sf.read(path, dtype="float32")[0] - sf.read(backing, dtype="float32")[0]
        archive = client.app.state.container.recordings.archive
        archive._archive_one(path.parent / "archive-pending.json")
        original = client.app.state.container.recordings.get.execute(take["recordingId"])
        assert original.file_path.suffix == ".flac" and not path.exists()
        preserved = {item: item.read_bytes() for item in (original.file_path, backing)}
        provider._descriptor = replace(
            provider.descriptor,
            capabilities=provider.descriptor.capabilities - {AiCapability.SEPARATION},
        )
        response = client.post(f"/recordings/{take['recordingId']}/studio-master")
        assert response.status_code == 202, response.text
        job = wait_for_job(client, response.json()["jobId"], timeout=30)
        assert job["state"] == "Succeeded", job
        master = client.get(f"/recordings/{job['report']['recordingId']}").json()
        output, rate = sf.read(master["filePath"], dtype="float32")
        assert rate == 16000 and len(output) == len(expected) and np.isfinite(output).all()
        assert master["sourceRecordingId"] == take["recordingId"]
        assert master["songRevision"] == take["songRevision"]
        np.testing.assert_allclose(sf.read(Path(str(path) + ".vocal.wav"))[0], expected, atol=1e-7)
        assert {item: item.read_bytes() for item in preserved} == preserved
