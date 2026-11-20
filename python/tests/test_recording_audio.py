from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure import recording_audio
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.process_runner import ProcessRunner


def _recording(path: Path, *, subtype: str = "PCM_24") -> Path:
    time = np.arange(48000) / 48000
    samples = np.column_stack(
        (0.15 * np.sin(2 * np.pi * 440 * time), 0.1 * np.sin(2 * np.pi * 660 * time))
    )
    sf.write(path, samples, 48000, subtype=subtype)
    return path


def _compact(source: Path, *, master: bool = False) -> Path:
    return recording_audio.compact_recording(
        source, ProcessRunner(), threading.Event(), master=master
    )


def test_master_archive_checks_delivered_mp3_and_waveform(tmp_path: Path):
    source = _recording(tmp_path / "recording.wav")
    before = sha256_file(source)
    target = _compact(source, master=True)
    assert target.suffix == ".mp3"
    assert sf.info(target).frames == sf.info(source).frames
    assert (sf.info(target).samplerate, sf.info(target).channels) == (48000, 2)
    assert sha256_file(source) == before
    peaks = json.loads(Path(str(target) + ".peaks.json").read_text())
    assert peaks["sha256"] == sha256_file(target)
    assert peaks["size"] == target.stat().st_size
    assert len(peaks["peaks"]) == 4096
    report = json.loads(Path(str(target) + ".archive.json").read_text())
    assert report["format"] == "MP3"
    assert report["truePeakDbtp"] <= -1
    assert report["sha256"] == peaks["sha256"]


def test_original_without_retained_sources_stays_lossless(tmp_path: Path):
    source = _recording(tmp_path / "recording.wav", subtype="PCM_16")
    target = _compact(source)
    assert target.suffix == ".flac"
    np.testing.assert_array_equal(
        sf.read(source, dtype="int32")[0], sf.read(target, dtype="int32")[0]
    )
    assert not source.with_suffix(".mp3").exists()


def test_original_with_verified_sources_gets_compact_listening_copy(tmp_path: Path):
    source = _recording(tmp_path / "recording.wav", subtype="PCM_16")
    stems = [Path(str(source) + suffix) for suffix in (".vocal.wav", ".backing.wav")]
    for stem in stems:
        _recording(stem, subtype="FLOAT")
    before = {stem: sha256_file(stem) for stem in stems}
    target = _compact(source)
    assert target.suffix == ".mp3"
    assert {stem: sha256_file(stem) for stem in stems} == before


@pytest.mark.parametrize("invalid", ["nonfinite", "mismatched", "lossy", "adpcm"])
def test_invalid_retained_sources_never_replace_only_lossless_mix(tmp_path: Path, invalid: str):
    source = _recording(tmp_path / "recording.wav", subtype="PCM_16")
    vocal, backing = [Path(str(source) + suffix) for suffix in (".vocal.wav", ".backing.wav")]
    _recording(backing, subtype="FLOAT")
    if invalid == "nonfinite":
        sf.write(vocal, np.full((48000, 2), np.nan), 48000, subtype="FLOAT")
    elif invalid == "mismatched":
        sf.write(vocal, np.zeros((24000, 2)), 48000, subtype="FLOAT")
    elif invalid == "adpcm":
        sf.write(vocal, sf.read(source)[0], 48000, subtype="IMA_ADPCM")
        samples = sf.read(vocal)[0]
        sf.write(source, samples, 48000, subtype="PCM_16")
        sf.write(backing, samples * 0.2, 48000, subtype="FLOAT")
    else:
        encoded = _compact(source, master=True)
        vocal.write_bytes(encoded.read_bytes())
    target = _compact(source)
    assert target.suffix == ".flac"
    np.testing.assert_array_equal(
        sf.read(source, dtype="int32")[0], sf.read(target, dtype="int32")[0]
    )


def test_master_peak_overshoot_retains_verified_lossless_audio(tmp_path: Path, monkeypatch):
    source = _recording(tmp_path / "recording.wav")
    monkeypatch.setattr(
        recording_audio, "_measure", lambda *args: {"input_tp": -0.4, "input_i": -14.0}
    )
    target = _compact(source, master=True)
    assert target.suffix == ".flac"
    assert not source.with_suffix(".mp3").exists()
    np.testing.assert_array_equal(
        sf.read(source, dtype="int32")[0], sf.read(target, dtype="int32")[0]
    )


def test_peak_measurement_failure_keeps_previous_files(tmp_path: Path, monkeypatch):
    source = _recording(tmp_path / "recording.wav")
    old = source.with_suffix(".mp3")
    old.write_bytes(b"previous owned publication")
    before = {path: path.read_bytes() for path in (source, old)}

    def fail(*args):
        raise ValueError("meter unavailable")

    monkeypatch.setattr(recording_audio, "_measure", fail)
    with pytest.raises(ValueError, match="meter unavailable"):
        _compact(source, master=True)
    assert {path: path.read_bytes() for path in before} == before
    assert not list(tmp_path.glob(".recording-archive-*"))


def test_existing_compact_recording_is_not_encoded_again(tmp_path: Path, monkeypatch):
    from backend.infrastructure import project_audio

    source = _recording(tmp_path / "recording.wav")
    compact = _compact(source, master=True)
    before = sha256_file(compact)

    def forbidden(*args):
        raise AssertionError("a second lossy encoding is forbidden")

    monkeypatch.setattr(project_audio, "_encode", forbidden)
    assert _compact(compact, master=True) == compact
    assert sha256_file(compact) == before
    report = json.loads(Path(str(compact) + ".archive.json").read_text())
    assert report["reused"] is True
    assert "bitrate" not in report


def test_multichannel_recording_uses_lossless_without_copying_onto_itself(tmp_path: Path):
    source = tmp_path / "recording.wav"
    samples = np.tile(np.linspace(-0.2, 0.2, 48000)[:, None], (1, 6))
    sf.write(source, samples, 48000, subtype="PCM_16")
    target = _compact(source, master=True)
    assert target.suffix == ".flac"
    assert sf.info(target).channels == 6
    np.testing.assert_array_equal(
        sf.read(source, dtype="int32")[0], sf.read(target, dtype="int32")[0]
    )


def test_unsafe_existing_mp3_is_not_deleted_as_a_rejected_candidate(tmp_path: Path, monkeypatch):
    source = _recording(tmp_path / "recording.wav")
    compact = _compact(source, master=True)
    source.unlink()
    before = compact.read_bytes()
    monkeypatch.setattr(recording_audio, "_measure", lambda *args: {"input_tp": 0.5})
    with pytest.raises(ValueError, match="Existing MP3"):
        _compact(compact, master=True)
    assert compact.read_bytes() == before


def test_arbitrary_capture_length_archives_without_changing_its_timeline(tmp_path: Path):
    source = tmp_path / "recording.wav"
    time = np.arange(65673) / 48000
    samples = np.column_stack(
        (0.1 * np.sin(2 * np.pi * 440 * time), 0.1 * np.sin(2 * np.pi * 660 * time))
    )
    sf.write(source, samples, 48000, subtype="PCM_24")
    before = source.read_bytes()
    target = _compact(source, master=True)
    assert sf.info(target).frames == 65673
    assert sf.info(target).samplerate == 48000
    assert sf.info(target).channels == 2
    assert source.read_bytes() == before
    if target.suffix == ".flac":
        np.testing.assert_array_equal(
            sf.read(source, dtype="int32")[0], sf.read(target, dtype="int32")[0]
        )
