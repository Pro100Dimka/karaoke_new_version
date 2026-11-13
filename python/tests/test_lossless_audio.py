import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure import lossless_audio
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.process_runner import ProcessRunner


@pytest.mark.parametrize("subtype,channels", [("PCM_16", 2), ("PCM_24", 6)])
def test_flac_preserves_every_sample_and_provides_verified_peaks(tmp_path, subtype, channels):
    source = tmp_path / "recording.wav"
    signal = np.random.default_rng(42).uniform(-0.9, 0.9, (8192, channels))
    sf.write(source, signal, 48000, subtype=subtype)
    expected, rate = sf.read(source, dtype="int32", always_2d=True)
    target = lossless_audio.compress_audio(source, ProcessRunner(), threading.Event())
    actual, actual_rate = sf.read(target, dtype="int32", always_2d=True)
    assert target.suffix == ".flac"
    assert source.exists()
    assert actual_rate == rate
    np.testing.assert_array_equal(actual, expected)
    peaks = json.loads(Path(str(target) + ".peaks.json").read_text())
    assert peaks["sha256"] == sha256_file(target)
    assert peaks["size"] == target.stat().st_size
    assert len(peaks["peaks"]) == 4096
    assert max(peaks["peaks"]) == 1


def test_float_recording_is_retained_without_quantization(tmp_path):
    source = tmp_path / "recording.wav"
    sf.write(source, [0.123456789, -0.123456789], 48000, subtype="FLOAT")
    before = source.read_bytes()
    assert lossless_audio.compress_audio(source, ProcessRunner(), threading.Event()) == source
    assert source.read_bytes() == before
    assert not source.with_suffix(".flac").exists()


def test_failed_sample_verification_preserves_source_and_previous_target(tmp_path, monkeypatch):
    source = tmp_path / "recording.wav"
    sf.write(source, np.zeros(4096), 48000, subtype="PCM_24")
    before = source.read_bytes()
    target = source.with_suffix(".flac")
    target.write_bytes(b"previous published audio")
    monkeypatch.setattr(lossless_audio, "audio_digest", lambda path, *args: str(path).encode())
    with pytest.raises(ValueError, match="samples differ"):
        lossless_audio.compress_audio(source, ProcessRunner(), threading.Event())
    assert source.read_bytes() == before
    assert target.read_bytes() == b"previous published audio"
    assert not source.with_name("recording.compressing.flac").exists()
