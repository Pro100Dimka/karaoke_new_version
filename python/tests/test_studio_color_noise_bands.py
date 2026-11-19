"""Tone enhancement must use noise evidence in the band it would amplify."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_adaptive_features import analyze_voice
from backend.recordings.studio_adaptive_voice import _color_plan
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_voice import render_voice_filters


def _sources(tmp_path: Path, scale: float, *, hiss: bool = False):
    rate = 48000
    time = np.arange(rate * 7) / rate
    active = (time >= 1) & (time < 5)
    body = 0.08 * np.sin(2 * np.pi * 500 * time)
    anchor = 0.01 * np.sin(2 * np.pi * 1200 * time)
    presence = np.sin(2 * np.pi * 2800 * time)
    air = np.sin(2 * np.pi * 11000 * time)
    # Dominant low-frequency room noise says nothing about upper-band SNR.
    room = 0.003 * np.sin(2 * np.pi * 90 * time)
    voice = active * (body + anchor + 0.004 * presence + 0.0015 * air) + room
    if hiss:
        random = np.random.default_rng(901).normal(0, 0.006, len(time))
        voice += sosfilt(butter(4, (8000, 16000), fs=rate, btype="bandpass", output="sos"), random)
    reference = active * (body + anchor + 0.0075 * presence + 0.004 * air)
    source, origin = tmp_path / "voice.wav", tmp_path / "reference.wav"
    sf.write(source, scale * voice, rate, subtype="FLOAT")
    sf.write(origin, scale * reference, rate, subtype="FLOAT")
    cancel = threading.Event()
    actual, expected = analyze_voice(source, cancel), analyze_voice(origin, cancel)
    return source, actual, expected, cancel


def _amplitude(samples: np.ndarray, rate: int, frequency: float) -> float:
    section = samples[rate * 2 : rate * 4]
    phase = 2j * np.pi * frequency * np.arange(len(section)) / rate
    return float(abs(np.mean(section * np.exp(phase))))


@pytest.mark.parametrize("scale", [1.0, 0.15])
def test_low_frequency_room_noise_does_not_block_clean_presence_and_air(tmp_path, scale):
    source, actual, expected, cancel = _sources(tmp_path, scale)
    assert actual.noise_confident
    filters, report = _color_plan(actual, expected)
    target = tmp_path / "colored.wav"
    render_voice_filters(
        FfmpegStudioMasterRenderer(ProcessRunner()), source, target, filters, cancel
    )
    before, rate = sf.read(source)
    after, actual_rate = sf.read(target)
    assert actual_rate == rate and before.shape == after.shape
    for frequency, minimum in ((2800, 0.3), (11000, 0.7)):
        gain = 20 * np.log10(
            _amplitude(after, rate, frequency) / _amplitude(before, rate, frequency)
        )
        assert minimum < gain < 1.6
    assert len(report["bands"]) == 2


def test_noise_in_air_band_is_not_brightened_by_a_low_frequency_floor(tmp_path):
    _, actual, expected, _ = _sources(tmp_path, 1.0, hiss=True)
    assert actual.noise_confident
    _, report = _color_plan(actual, expected)
    assert all(band["frequencyHz"] != 11000 for band in report["bands"])
