"""Dark sung vowels still need spectral room when their upper harmonics clear noise."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_adaptive_mix import duck_backing

_RATE = 16000


def _wave(root: Path, name: str, samples: np.ndarray) -> Path:
    path = root / f"{name}.wav"
    sf.write(path, samples, _RATE, subtype="FLOAT")
    return path


def _signals(upper_harmonic: float, *, continuous: bool = False) -> tuple[np.ndarray, np.ndarray]:
    time = np.arange(6 * _RATE) / _RATE
    phrase = np.ones_like(time) if continuous else ((time >= 1) & (time < 4))
    body = 0.12 * np.sin(2 * np.pi * 220 * time)
    upper = upper_harmonic * np.sin(2 * np.pi * 2420 * time)
    room = 0.0008 * np.sin(2 * np.pi * 90 * time)
    hiss = np.random.default_rng(92).normal(size=len(time)) * 0.00003
    vocal = phrase * (body + upper) + room + hiss
    music = 0.1 * np.sin(2 * np.pi * 120 * time) + 0.06 * np.sin(2 * np.pi * 2420 * time)
    return vocal, np.column_stack((music, music * 0.6))


def _tone_gain(before: np.ndarray, after: np.ndarray, hz: float) -> float:
    region = slice(2 * _RATE, 3 * _RATE)
    basis = np.exp(-2j * np.pi * hz * np.arange(_RATE) / _RATE)
    return float(abs(np.dot(after[region, 0], basis)) / abs(np.dot(before[region, 0], basis)))


@pytest.mark.parametrize("capture_gain", [1.0, 0.05])
def test_dark_voiced_harmonics_above_band_noise_make_room(tmp_path, capture_gain):
    # The sung upper harmonic is 26 dB below the body, yet well above room hiss.
    vocal, music = _signals(0.006)
    voice = _wave(tmp_path, "voice", vocal * capture_gain)
    backing = _wave(tmp_path, "backing", music)
    target = tmp_path / "ducked.wav"
    report = duck_backing(voice, backing, target, threading.Event())
    before, rate = sf.read(backing)
    after, out_rate = sf.read(target)
    reduction = -20 * np.log10(_tone_gain(before, after, 2420))
    assert 1.0 < reduction <= 3.0001
    assert report["applied"]
    assert 0 < report["maxReductionDb"] <= 3.0001
    assert after.shape == before.shape and out_rate == rate
    assert _tone_gain(before, after, 120) == pytest.approx(1, abs=0.005)
    np.testing.assert_allclose(after[:, 1], after[:, 0] * 0.6, atol=2e-8)
    # Far from a phrase boundary, even the original FLOAT samples must survive.
    np.testing.assert_array_equal(after[: _RATE // 2], before[: _RATE // 2])
    np.testing.assert_array_equal(after[5 * _RATE :], before[5 * _RATE :])
    assert report["vocalBandSupport"]["method"] == "quiet-band-signal-to-noise"
    assert report["vocalBandSupport"]["minimumSignalToNoiseDb"] == 8


def test_stationary_band_hiss_does_not_trigger_dark_voice_ducking(tmp_path):
    # Loud low-frequency content alone does not establish useful upper-band voice.
    vocal, music = _signals(0.0)
    voice = _wave(tmp_path, "voice", vocal)
    backing = _wave(tmp_path, "backing", music)
    target = tmp_path / "ducked.wav"
    report = duck_backing(voice, backing, target, threading.Event())
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(backing)[0], sf.read(target)[0])


@pytest.mark.parametrize("upper_harmonic,expected", [(0.006, False), (0.03, True)])
def test_missing_quiet_evidence_keeps_existing_relative_band_gate(
    tmp_path, upper_harmonic, expected
):
    vocal, music = _signals(upper_harmonic, continuous=True)
    voice = _wave(tmp_path, "voice", vocal)
    backing = _wave(tmp_path, "backing", music)
    target = tmp_path / "ducked.wav"
    report = duck_backing(voice, backing, target, threading.Event())
    assert report["applied"] is expected
    if expected:
        assert report["vocalBandSupport"]["method"] == "relative-band-fallback"
    else:
        np.testing.assert_array_equal(sf.read(backing)[0], sf.read(target)[0])
