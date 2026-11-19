"""Ordinary sung syllables must not be leveled against neighboring breath noise."""

import threading

import numpy as np
import pytest
from scipy.signal import butter, sosfilt
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import build_gain_plan
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _microverse(rate, breath_db, accent_db=0):
    time = np.arange(rate * 14) / rate
    envelope = ((time < 3) | (time >= 11)).astype(float)
    words = []
    for index, duration in enumerate([0.08, 0.15, 0.28, 0.12, 0.32, 0.1, 0.18, 0.24, 0.15]):
        start = 3.5 + index * 0.8
        attack = np.clip((time - start) / 0.005, 0, 1)
        release = np.clip((start + duration - time) / 0.005, 0, 1)
        gain = 10 ** (accent_db / 20) if index == 1 else 1
        envelope = np.maximum(envelope, np.minimum(attack, release) * gain)
        words.append((time >= start + 0.02) & (time < start + duration - 0.02))
    noise = sosfilt(
        butter(2, [500, 3400], fs=rate, btype="bandpass", output="sos"),
        np.random.default_rng(73).normal(size=len(time)),
    )
    noise *= (0.05 / np.sqrt(2) * 10 ** (breath_db / 20)) / np.sqrt(np.mean(noise**2))
    voice = 0.05 * np.sin(2 * np.pi * 700 * time) * envelope
    voice += noise * (1 - np.minimum(envelope, 1))
    return time, voice, words


def _render(root, rate, voice, time):
    source, backing, target = [root / f"{name}.wav" for name in ["voice", "backing", "out"]]
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(backing, 0.05 * np.sin(2 * np.pi * 900 * time), rate, subtype="FLOAT")
    originals = [path.read_bytes() for path in [source, backing]]
    cancel = threading.Event()
    plan = build_gain_plan(
        FfmpegStudioMasterRenderer(ProcessRunner()), source, backing, 0.5, cancel
    )
    _write_gain_envelope(source, target, plan.times, plan.gains, cancel)
    actual, actual_rate = sf.read(target)
    assert actual_rate == rate and actual.shape == voice.shape
    assert np.isfinite(actual).all()
    assert [path.read_bytes() for path in [source, backing]] == originals
    return actual


def _level(samples):
    return float(10 * np.log10(np.mean(samples**2)))


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("breath_db", [-12, -18, -30])
def test_short_sung_words_retain_the_same_level_as_long_words(tmp_path, rate, breath_db):
    time, voice, words = _microverse(rate, breath_db)
    actual = _render(tmp_path, rate, voice, time)
    steady = (time >= 1) & (time < 2)
    steady_gain = _level(actual[steady]) - _level(voice[steady])
    # The varying durations straddle half the local median window. A musical
    # syllable does not become an exceptional accent because its neighbors breathe.
    for selected in words:
        assert abs(_level(voice[selected]) - _level(voice[steady])) < 0.15
        gain = _level(actual[selected]) - _level(voice[selected])
        assert gain - steady_gain > -2


@pytest.mark.parametrize("rate", [44100, 48000])
def test_genuinely_loud_syllable_among_breaths_still_gets_controlled(tmp_path, rate):
    time, voice, words = _microverse(rate, -18, accent_db=12)
    actual = _render(tmp_path, rate, voice, time)
    steady = (time >= 1) & (time < 2)
    assert _level(voice[words[1]]) - _level(voice[steady]) > 11
    assert _level(actual[words[1]]) - _level(actual[steady]) < 4
