from __future__ import annotations

import math
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings.studio_audio import _profile


def test_center_profile_has_the_same_level_for_mono_and_duplicated_stereo(tmp_path):
    rate = 8000
    samples = np.random.default_rng(18).normal(0, 0.05, rate * 2)
    mono, stereo = tmp_path / "mono.wav", tmp_path / "stereo.wav"
    sf.write(mono, samples, rate, subtype="FLOAT")
    sf.write(stereo, np.repeat(samples[:, None], 2, axis=1), rate, subtype="FLOAT")
    cancel = threading.Event()
    expected = _profile(mono, cancel, voice_band=True)
    actual = _profile(stereo, cancel, voice_band=True, center=True)
    np.testing.assert_allclose(actual, expected, atol=1e-9)


@pytest.mark.parametrize("subtype", ["PCM_16", "PCM_24", "FLOAT", "DOUBLE"])
def test_profile_keeps_original_double_precision_rms(tmp_path, subtype):
    rate = 8000
    samples = np.random.default_rng(42).normal(0, 0.1, size=(rate, 2))
    path = tmp_path / "recording.wav"
    sf.write(path, samples, rate, subtype=subtype)
    with sf.SoundFile(path) as source:
        actual = source.read(dtype="float64", always_2d=True)
    expected = np.array(
        [
            10 * math.log10(max(1e-12, float(np.mean(block * block))))
            for block in np.split(actual, 10)
        ]
    )
    np.testing.assert_allclose(_profile(path, threading.Event()), expected, atol=1e-5, rtol=0)


def test_profile_raises_on_cancelled_audio(tmp_path):
    path = tmp_path / "recording.wav"
    sf.write(path, np.zeros(8000), 8000)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        _profile(path, cancel)


def test_profile_does_not_mask_invalid_audio(tmp_path):
    path = tmp_path / "recording.wav"
    sf.write(path, np.array([0.0, np.nan, 0.1], dtype=np.float32), 8000, subtype="FLOAT")
    with pytest.raises(Exception, match="invalid samples"):
        _profile(path, threading.Event())


@pytest.mark.parametrize("seconds,channels", [(8.4, 1), (8.4, 2), (131.4, 6)])
def test_overlapping_reference_windows_decode_each_frame_once(tmp_path, monkeypatch, seconds, channels):
    from backend.recordings.studio_space_analysis import _sample_cepstra, _cepstrum

    rate = 8000
    audio = np.random.default_rng(123).normal(0, 0.05, (round(rate * seconds), channels))
    path = tmp_path / "reference.flac"
    sf.write(path, audio, rate, subtype="PCM_24")
    decoded, _ = sf.read(path, dtype="float32", always_2d=True)
    starts = np.arange(0, len(audio) - 2 * rate + 1, rate)
    if len(starts) > 128:
        starts = starts[np.linspace(0, len(starts) - 1, 128).astype(int)]
    expected = [_cepstrum(decoded[start:start + 2 * rate, :2], rate) for start in starts]
    original_read = sf.SoundFile.read
    frames = []

    def tracked_read(source, *args, **kwargs):
        samples = original_read(source, *args, **kwargs)
        frames.append(len(samples))
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", tracked_read)
    with sf.SoundFile(path) as source:
        _, actual, positions = _sample_cepstra(source, threading.Event())
    np.testing.assert_array_equal(positions, starts / rate)
    np.testing.assert_array_equal(actual, expected)
    assert sum(frames) <= len(audio)
