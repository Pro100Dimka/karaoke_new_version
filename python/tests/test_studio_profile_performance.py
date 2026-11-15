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
def test_overlapping_reference_windows_decode_each_frame_once(
    tmp_path, monkeypatch, seconds, channels
):
    from backend.recordings.studio_space_analysis import _sample_cepstra, _cepstrum

    rate = 8000
    audio = np.random.default_rng(123).normal(0, 0.05, (round(rate * seconds), channels))
    path = tmp_path / "reference.flac"
    sf.write(path, audio, rate, subtype="PCM_24")
    decoded, _ = sf.read(path, dtype="float32", always_2d=True)
    starts = np.arange(0, len(audio) - 2 * rate + 1, rate)
    if len(starts) > 128:
        starts = starts[np.linspace(0, len(starts) - 1, 128).astype(int)]
    expected = [_cepstrum(decoded[start : start + 2 * rate, :2], rate) for start in starts]
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


@pytest.mark.parametrize(
    "channels,center,band,seconds",
    [(1, False, False, 0.02), (2, False, True, 0.1), (2, True, True, 0.1)],
)
def test_batched_profile_keeps_the_partial_final_frame(channels, center, band, seconds, tmp_path):
    rate = 8000
    size = round(rate * seconds)
    samples = np.random.default_rng(14).normal(0, 0.05, (size * 35 + size // 3, channels))
    path = tmp_path / "partial.wav"
    sf.write(path, samples, rate, subtype="DOUBLE")
    expected = []
    for start in range(0, len(samples), size):
        block = samples[start : start + size]
        if center:
            block = block.mean(axis=1, keepdims=True)
        power = float(np.mean(block**2))
        if band:
            window = np.hanning(len(block))[:, None]
            hz = np.fft.rfftfreq(len(block), 1 / rate)
            spectrum = np.fft.rfft(block * window, axis=0)
            power = 2 * np.sum(abs(spectrum[(hz >= 300) & (hz <= 3500)]) ** 2)
            power /= max(1, len(block) * np.sum(window**2) * block.shape[1])
        expected.append(10 * np.log10(max(power, 1e-12)))
    np.testing.assert_allclose(
        _profile(path, threading.Event(), frame_seconds=seconds, center=center, voice_band=band),
        expected,
        atol=1e-10,
        rtol=0,
    )


@pytest.mark.parametrize("channels", [1, 2])
def test_cached_convolution_preserves_block_boundaries_and_the_final_partial_block(
    tmp_path, monkeypatch, channels
):
    from scipy.signal import fftconvolve
    from backend.recordings.studio_space import SpaceProfile, _SpatialBuses

    rng = np.random.default_rng(73)
    samples = rng.normal(0, 0.04, (32768 * 2 + 119, channels)).astype("float32")
    impulse = rng.normal(0, 0.001, (4097, channels)).astype("float32")
    voice = tmp_path / "voice.wav"
    sf.write(voice, samples, 8000, subtype="FLOAT")
    profile = SpaceProfile(reverb_gain=0.1)
    buses = _SpatialBuses(voice, tmp_path / "out.wav", threading.Event(), {"reverb": profile})
    monkeypatch.setattr(buses, "_impulse", lambda *args: impulse)
    buses._convolve("reverb", profile)
    actual, rate = sf.read(buses.paths["reverb"], dtype="float32", always_2d=True)
    expected = fftconvolve(samples, impulse, axes=0)[: len(samples)]
    assert rate == 8000 and actual.shape == samples.shape
    np.testing.assert_allclose(actual, expected, atol=2e-7, rtol=0)
