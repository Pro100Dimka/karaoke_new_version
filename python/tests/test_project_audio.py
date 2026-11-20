from __future__ import annotations

import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.project_audio import compact_audio, compact_stems


def _source(path: Path, *, rate: int = 44100, channels: int = 2) -> Path:
    time = np.arange(rate * 2 + 137) / rate
    left = 0.1 * np.sin(2 * np.pi * 440 * time)
    right = 0.08 * np.sin(2 * np.pi * 659.25 * time)
    left[:1537] = 0
    right[-1789:] = 0
    signal = np.column_stack((left, right))[:, :channels]
    sf.write(path, signal, rate, subtype="PCM_24")
    return path


@pytest.mark.parametrize("rate,channels", [(32000, 1), (44100, 2), (48000, 2)])
def test_compact_stem_keeps_exact_timeline_stereo_and_encoded_peaks(tmp_path, rate, channels):
    source = _source(tmp_path / "исходный вокал.wav", rate=rate, channels=channels)
    before = source.read_bytes()
    target = tmp_path / "published" / "instrumental.mp3"

    result = compact_audio(source, target, ProcessRunner(), threading.Event(), peaks=True)

    assert result == target
    assert source.read_bytes() == before
    expected, expected_rate = sf.read(source, always_2d=True)
    actual, actual_rate = sf.read(target, always_2d=True)
    assert actual_rate == expected_rate
    assert actual.shape == expected.shape
    assert np.isfinite(actual).all()
    for channel in range(channels):
        assert np.corrcoef(actual[:, channel], expected[:, channel])[0, 1] > 0.999
    metadata = json.loads(Path(str(target) + ".peaks.json").read_text())
    assert metadata["sha256"] == sha256_file(target)
    assert metadata["size"] == target.stat().st_size
    assert len(metadata["peaks"]) == 4096
    assert max(metadata["peaks"]) == 1
    assert not list(target.parent.glob("*.encoding*"))


def test_already_compact_stems_are_copied_without_another_lossy_encode(tmp_path):
    source = _source(tmp_path / "source.wav")
    original = compact_audio(
        source, tmp_path / "first.mp3", ProcessRunner(), threading.Event(), peaks=False
    )
    before = original.read_bytes()

    class NoEncoder:
        def run(self, *args, **kwargs):
            raise AssertionError("Existing MP3 must not be encoded again")

    target = compact_audio(
        original, tmp_path / "second.mp3", NoEncoder(), threading.Event(), peaks=True
    )

    assert original.read_bytes() == before == target.read_bytes()
    assert not Path(str(original) + ".peaks.json").exists()
    assert Path(str(target) + ".peaks.json").is_file()


def test_failed_compact_encode_preserves_source_and_previous_target(tmp_path):
    source = _source(tmp_path / "source.wav")
    before = source.read_bytes()
    target = tmp_path / "stem.mp3"
    target.write_bytes(b"previous published file")

    class FailingEncoder:
        def run(self, arguments, **kwargs):
            Path(arguments[-1]).write_bytes(b"partial encoded data")
            return ProcessResult(1, b"", b"encoder failed")

    with pytest.raises(ValueError, match="encoding failed"):
        compact_audio(source, target, FailingEncoder(), threading.Event(), peaks=True)
    assert source.read_bytes() == before
    assert target.read_bytes() == b"previous published file"
    assert not list(tmp_path.glob("*.encoding*"))


def test_compact_detection_uses_decoded_format_instead_of_filename(tmp_path):
    source = _source(tmp_path / "source.wav")
    mislabeled = tmp_path / "legacy.mp3"
    mislabeled.write_bytes(source.read_bytes())
    target = compact_audio(
        mislabeled, tmp_path / "result.mp3", ProcessRunner(), threading.Event(), peaks=False
    )
    assert sf.info(target).format == "MP3"
    assert sf.info(target).frames == sf.info(source).frames
    assert mislabeled.read_bytes() == source.read_bytes()


def test_compact_encode_rejects_duration_change_before_replacing_target(tmp_path):
    source = _source(tmp_path / "source.wav")
    target = tmp_path / "stem.mp3"
    target.write_bytes(b"previous published file")
    runner = ProcessRunner()

    class TruncatingEncoder:
        def run(self, arguments, **kwargs):
            return runner.run([*arguments[:-1], "-t", "1", arguments[-1]], **kwargs)

    with pytest.raises(ValueError, match="duration or layout"):
        compact_audio(source, target, TruncatingEncoder(), threading.Event(), peaks=False)
    assert target.read_bytes() == b"previous published file"
    assert not list(tmp_path.glob("*.encoding*"))


def test_cancellation_does_not_publish_compact_audio(tmp_path):
    source = _source(tmp_path / "source.wav")
    cancel = threading.Event()
    cancel.set()
    target = tmp_path / "stem.mp3"
    with pytest.raises(InterruptedError):
        compact_audio(source, target, ProcessRunner(), cancel, peaks=True)
    assert source.exists() and not target.exists()


def test_non_mpeg_sample_rate_stays_lossless_without_resampling(tmp_path):
    source = _source(tmp_path / "source.wav", rate=96000)
    before = source.read_bytes()
    target = compact_audio(
        source, tmp_path / "new" / "stem.mp3", ProcessRunner(), threading.Event(), peaks=True
    )
    assert target.suffix == ".flac"
    expected, rate = sf.read(source, dtype="int32")
    actual, actual_rate = sf.read(target, dtype="int32")
    assert actual_rate == rate == 96000
    np.testing.assert_array_equal(actual, expected)
    assert source.read_bytes() == before


def test_two_stems_encode_concurrently_but_keep_their_logical_order(tmp_path, monkeypatch):
    from backend.infrastructure import project_audio

    barrier = threading.Barrier(2)
    calls = []

    def prepare(source, target, runner, cancel, *, peaks):
        barrier.wait(timeout=5)
        calls.append((source.name, peaks))
        return target

    monkeypatch.setattr(project_audio, "compact_audio", prepare)
    results = compact_stems(tmp_path / "backing.wav", tmp_path / "voice.wav", tmp_path / "output")
    assert [path.name for path in results] == ["instrumental.mp3", "reference-vocal.mp3"]
    assert sorted(calls) == [("backing.wav", True), ("voice.wav", False)]
