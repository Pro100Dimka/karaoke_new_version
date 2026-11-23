from __future__ import annotations

import importlib
import os
import threading
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.start_studio_master import StartStudioMaster
from backend.recordings.studio_audio import recording_stems


@pytest.fixture
def archive():
    return importlib.import_module("backend.infrastructure.recording_sources")


def _take(root: Path, suffix: str = ".wav", *, frames: int = 65536 + 137):
    mix = root / f"recording{suffix}"
    rate, channels = 48000, 2
    if suffix == ".mp3":
        fixture = Path(__file__).parents[2] / "AudioService/tests/media/fixtures/seek-44100.mp3"
        mix.write_bytes(fixture.read_bytes())
        info = sf.info(mix)
        rate, channels, frames = info.samplerate, info.channels, info.frames
    samples = np.random.default_rng(46).integers(-16384, 16384, (frames, channels))
    samples = samples.astype(np.float32) / 32768
    if suffix != ".mp3":
        sf.write(mix, samples, rate, subtype="PCM_16")
    paths = tuple(root / f"recording.wav.{kind}.wav" for kind in ("dry", "vocal", "backing"))
    for path in paths:
        sf.write(path, samples, rate, subtype="FLOAT")
    return mix, *paths


@pytest.mark.parametrize("suffix", [".wav", ".flac", ".mp3"])
def test_dry_archive_retains_every_sample_and_only_retires_the_verified_wav(
    tmp_path: Path, archive, suffix: str
):
    mix, dry, vocal, backing = _take(tmp_path, suffix)
    originals = {path: path.read_bytes() for path in (mix, dry, vocal, backing)}
    prepared = archive.prepare_dry_archive(mix, threading.Event())
    assert prepared is not None
    assert prepared.source == dry
    assert prepared.target == tmp_path / "recording.wav.dry.flac"
    assert prepared.target.stat().st_size < dry.stat().st_size
    actual, rate = sf.read(prepared.target, dtype="float32", always_2d=True)
    expected, expected_rate = sf.read(dry, dtype="float32", always_2d=True)
    assert rate == expected_rate
    np.testing.assert_array_equal(actual.view(np.uint32), expected.view(np.uint32))
    assert {path: path.read_bytes() for path in originals} == originals
    assert recording_stems(mix, prefer_dry=True) == (dry, backing)
    assert archive.prepare_dry_archive(mix, threading.Event()) == prepared
    archive.retire_dry_archive(prepared)
    assert not dry.exists()
    assert recording_stems(mix, prefer_dry=True) == (prepared.target, backing)
    assert {path: path.read_bytes() for path in (mix, vocal, backing)} == {
        path: originals[path] for path in (mix, vocal, backing)
    }
    archive.retire_dry_archive(prepared)
    assert archive.prepare_dry_archive(mix, threading.Event()) is None


@pytest.mark.parametrize("value", [0.12345679, 1e-10, -0.0, 1.0, -1.1, float("nan")])
def test_arbitrary_float_dry_audio_is_never_quantized(tmp_path: Path, archive, value: float):
    mix, dry, _, _ = _take(tmp_path, frames=8192)
    samples = np.full((8192, 2), value, dtype=np.float32)
    sf.write(dry, samples, 48000, subtype="FLOAT")
    before = dry.read_bytes()
    assert archive.prepare_dry_archive(mix, threading.Event()) is None
    assert dry.read_bytes() == before
    assert not dry.with_suffix(".flac").exists()
    assert not list(tmp_path.glob("*.preparing*"))


def test_incomplete_dry_audio_is_never_promoted_to_a_complete_source(tmp_path: Path, archive):
    mix, dry, vocal, backing = _take(tmp_path)
    incomplete = dry.with_name("recording.wav.dry-incomplete.wav")
    dry.rename(incomplete)
    before = incomplete.read_bytes()
    assert archive.prepare_dry_archive(mix, threading.Event()) is None
    assert recording_stems(mix, prefer_dry=True) == (vocal, backing)
    assert incomplete.read_bytes() == before
    assert not list(tmp_path.glob("*.flac"))


@pytest.mark.parametrize(
    "frames,rate,channels", [(17, 48000, 2), (8192, 44100, 2), (8192, 48000, 1)]
)
def test_dry_archive_rejects_unsynchronized_sources(
    tmp_path: Path, archive, frames: int, rate: int, channels: int
):
    mix, dry, _, _ = _take(tmp_path, frames=8192)
    sf.write(dry, np.zeros((frames, channels)), rate, subtype="FLOAT")
    before = dry.read_bytes()
    with pytest.raises(ValueError, match="synchronized"):
        archive.prepare_dry_archive(mix, threading.Event())
    assert dry.read_bytes() == before
    assert not dry.with_suffix(".flac").exists()


def test_dry_archive_does_not_keep_a_larger_replacement(tmp_path: Path, archive):
    mix, dry, _, _ = _take(tmp_path, frames=1)
    before = dry.read_bytes()
    assert archive.prepare_dry_archive(mix, threading.Event()) is None
    assert dry.read_bytes() == before
    assert not dry.with_suffix(".flac").exists()


@pytest.mark.parametrize("during_write", [False, True])
def test_dry_archive_cancellation_preserves_source_and_previous_target(
    tmp_path: Path, archive, monkeypatch, during_write: bool
):
    mix, dry, _, _ = _take(tmp_path)
    before = dry.read_bytes()
    target = dry.with_suffix(".flac")
    target.write_bytes(b"previous archive")
    cancel = threading.Event()
    write = sf.SoundFile.write

    def cancel_after_write(stream, samples):
        write(stream, samples)
        cancel.set()

    if during_write:
        monkeypatch.setattr(sf.SoundFile, "write", cancel_after_write)
    else:
        cancel.set()
    with pytest.raises(InterruptedError):
        archive.prepare_dry_archive(mix, cancel)
    assert dry.read_bytes() == before
    assert target.read_bytes() == b"previous archive"
    assert not list(tmp_path.glob("*.preparing*"))


def test_dry_archive_rejects_an_inexact_encoded_sample(tmp_path: Path, archive, monkeypatch):
    mix, dry, _, _ = _take(tmp_path)
    before = dry.read_bytes()
    write = sf.SoundFile.write

    def corrupt_one_sample(stream, samples):
        changed = samples.copy()
        changed[0, 0] += 1 / 32768
        write(stream, changed)

    monkeypatch.setattr(sf.SoundFile, "write", corrupt_one_sample)
    assert archive.prepare_dry_archive(mix, threading.Event()) is None
    assert dry.read_bytes() == before
    assert not dry.with_suffix(".flac").exists()
    assert not list(tmp_path.glob("*.preparing*"))


def test_dry_archive_encoder_failure_preserves_source_and_previous_target(
    tmp_path: Path, archive, monkeypatch
):
    mix, dry, _, _ = _take(tmp_path)
    before = dry.read_bytes()
    target = dry.with_suffix(".flac")
    target.write_bytes(b"previous archive")

    def fail_write(stream, samples):
        raise OSError("storage write failed")

    monkeypatch.setattr(sf.SoundFile, "write", fail_write)
    with pytest.raises(OSError, match="storage write failed"):
        archive.prepare_dry_archive(mix, threading.Event())
    assert dry.read_bytes() == before
    assert target.read_bytes() == b"previous archive"
    assert not list(tmp_path.glob("*.preparing*"))


def test_dry_archive_does_not_reuse_mislabeled_pcm(tmp_path: Path, archive):
    mix, dry, _, _ = _take(tmp_path)
    target = dry.with_suffix(".flac")
    samples, rate = sf.read(dry, dtype="float32")
    sf.write(target, samples, rate, format="WAV", subtype="PCM_16")
    prepared = archive.prepare_dry_archive(mix, threading.Event())
    assert prepared is not None
    assert sf.info(prepared.target).format == "FLAC"
    assert sf.info(prepared.target).subtype == "PCM_24"
    assert dry.exists()


def test_dry_archive_detects_source_change_before_publication(tmp_path: Path, archive, monkeypatch):
    mix, dry, _, _ = _take(tmp_path)
    target = dry.with_suffix(".flac")
    target.write_bytes(b"previous archive")
    write = sf.SoundFile.write

    def mutate_source_identity(stream, samples):
        write(stream, samples)
        current = dry.stat()
        os.utime(dry, ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000))

    monkeypatch.setattr(sf.SoundFile, "write", mutate_source_identity)
    with pytest.raises(ValueError, match="changed"):
        archive.prepare_dry_archive(mix, threading.Event())
    assert dry.exists() and target.read_bytes() == b"previous archive"
    assert not list(tmp_path.glob("*.preparing*"))


@pytest.mark.parametrize("changed", ["source", "target", "missing-target"])
def test_dry_retirement_requires_both_verified_file_identities(tmp_path: Path, archive, changed):
    mix, dry, _, _ = _take(tmp_path)
    prepared = archive.prepare_dry_archive(mix, threading.Event())
    assert prepared is not None
    path = dry if changed == "source" else prepared.target
    if changed == "missing-target":
        path.unlink()
    else:
        current = path.stat()
        os.utime(path, ns=(current.st_atime_ns, current.st_mtime_ns + 1_000_000))
    with pytest.raises(ValueError, match="changed|missing"):
        archive.retire_dry_archive(prepared)
    assert dry.exists()


def test_denied_dry_retirement_preserves_both_files_and_can_retry(tmp_path, archive, monkeypatch):
    mix, dry, _, _ = _take(tmp_path)
    prepared = archive.prepare_dry_archive(mix, threading.Event())
    assert prepared is not None
    unlink = Path.unlink

    def denied(path, *args, **kwargs):
        if path == dry:
            raise PermissionError("preview still owns the source")
        return unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", denied)
    with pytest.raises(PermissionError):
        archive.retire_dry_archive(prepared)
    assert dry.exists() and prepared.target.exists()
    monkeypatch.undo()
    archive.retire_dry_archive(prepared)
    assert not dry.exists() and prepared.target.exists()


def test_master_uses_archived_dry_source_and_prefers_the_native_wav(tmp_path: Path):
    mix, dry, vocal, backing = _take(tmp_path)
    archived = dry.with_suffix(".flac")
    samples, rate = sf.read(dry, dtype="float32")
    sf.write(archived, samples, rate, subtype="PCM_24")
    assert recording_stems(mix, prefer_dry=True) == (dry, backing)
    dry.unlink()
    assert recording_stems(mix, prefer_dry=True) == (archived, backing)
    assert recording_stems(mix) == (vocal, backing)


@pytest.mark.parametrize(
    "suffix,is_dry", [(".dry.wav", True), (".dry.flac", True), (".vocal.wav", False)]
)
def test_master_processes_both_dry_formats(tmp_path: Path, suffix: str, is_dry: bool):
    service = StartStudioMaster.__new__(StartStudioMaster)
    service._pitch_session = lambda context: nullcontext(None)
    service._render_budget = lambda recording: nullcontext(1)
    service._project_identity = lambda recording: ("song", 1)
    service._original_mix = lambda *args: None
    service._projects = SimpleNamespace(artifact_path=lambda *args: tmp_path / args[-1])
    calls = []
    service._renderer = SimpleNamespace(render=lambda *args, **kwargs: calls.append(kwargs))
    recording = SimpleNamespace(file_path=tmp_path / "recording.mp3", session_metadata={})
    context = SimpleNamespace(cancel=threading.Event(), progress=lambda *args: None)
    service._render(
        recording,
        (tmp_path / f"recording.wav{suffix}", tmp_path / "recording.wav.backing.wav"),
        True,
        tmp_path / "master.wav",
        context,
    )
    assert calls[0]["process_voice"] is is_dry
