"""Preserve normal vocal expression while controlling exceptional syllables."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import build_gain_plan
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _render(root: Path, rate: int, voice: np.ndarray, music: np.ndarray) -> np.ndarray:
    source, backing, output = (root / f"{name}.wav" for name in ("voice", "backing", "output"))
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(backing, music, rate, subtype="FLOAT")
    original_files = [path.read_bytes() for path in (source, backing)]
    cancel = threading.Event()
    plan = build_gain_plan(
        FfmpegStudioMasterRenderer(ProcessRunner()), source, backing, 0.5, cancel
    )
    _write_gain_envelope(source, output, plan.times, plan.gains, cancel)
    actual, actual_rate = sf.read(output)
    assert actual_rate == rate and actual.shape == voice.shape
    assert np.isfinite(actual).all()
    assert [path.read_bytes() for path in (source, backing)] == original_files
    return actual


def _level(samples: np.ndarray) -> float:
    return float(10 * np.log10(max(float(np.mean(samples**2)), 1e-12)))


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("frequency", [0.5, 1.0])
def test_leveling_preserves_modest_phrase_expression(tmp_path, rate, frequency):
    time = np.arange(rate * 12) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * time)
    voice *= 10 ** (6 * np.sin(2 * np.pi * frequency * time) / 20)
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    actual = _render(tmp_path, rate, voice, music)

    spans = []
    for signal in (voice, actual):
        blocks = signal[rate * 2 : rate * 10].reshape(-1, round(rate * 0.02))
        levels = 10 * np.log10(np.mean(blocks**2, axis=1))
        spans.append(float(np.ptp(np.percentile(levels, [10, 90]))))
    # Control the performance without reducing deliberate emphasis to one quarter
    # of its original depth; compare spans, so a constant loudness lift cannot pass.
    assert spans[1] >= 0.5 * spans[0]
    assert spans[1] <= spans[0] + 0.5


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("duration", [0.02, 0.2])
def test_loud_syllable_does_not_pull_down_the_preceding_unchanged_voice(tmp_path, rate, duration):
    time = np.arange(rate * 8) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    voice[(time >= 4) & (time < 4 + duration)] *= 8
    actual = _render(tmp_path, rate, voice, music)

    steady = (time >= 2) & (time < 3)
    before = (time >= 3.94) & (time < 3.98)
    gain = _level(actual[steady]) - _level(voice[steady])
    before_gain = _level(actual[before]) - _level(voice[before])
    assert abs(before_gain - gain) < 0.75


def test_long_unvoiced_section_keeps_the_neighboring_vocal_baseline(tmp_path):
    from scipy.signal import butter, sosfilt

    rate = 48000
    time = np.arange(rate * 14) / rate
    voice = 0.05 * np.sin(2 * np.pi * 700 * time)
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    breath = (time >= 2) & (time < 12)
    noise = sosfilt(
        butter(2, [500, 3400], fs=rate, btype="bandpass", output="sos"),
        np.random.default_rng(73).normal(size=len(time)),
    )
    noise *= 0.0035 / np.sqrt(np.mean(noise[breath] ** 2))
    voice[breath] = noise[breath]
    actual = _render(tmp_path, rate, voice, music)

    sung = (time >= 0.5) & (time < 1.5)
    middle = (time >= 6) & (time < 8)
    sung_gain = _level(actual[sung]) - _level(voice[sung])
    unvoiced_gain = _level(actual[middle]) - _level(voice[middle])
    assert -8 <= unvoiced_gain - sung_gain <= 2
