"""Check selective vocal cleanup through the real ADMaster rendering chain."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings import studio_voice
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _vocal_inputs(root, rate):
    time = np.arange(rate * 8) / rate
    body = sum(
        0.04 / harmonic * np.sin(2 * np.pi * 350 * harmonic * time) for harmonic in range(1, 5)
    )
    noise = sosfilt(
        butter(4, [4500, 10500], btype="bandpass", fs=rate, output="sos"),
        np.random.default_rng(1906).normal(size=len(time)),
    )
    noise *= 0.12 / np.sqrt(np.mean(noise**2))
    sibilants = sum((time >= start) & (time < start + 0.12) for start in (2, 4, 6))
    voice = body + noise * sibilants
    music = 0.025 * np.sin(2 * np.pi * 900 * time)
    paths = [root / f"{name}.wav" for name in ("voice", "music", "reference", "project", "mix")]
    for path, samples in zip(paths, (voice, music, body, music, voice + music)):
        sf.write(path, np.column_stack((samples, samples * 0.9)), rate, subtype="FLOAT")
    return paths


def _render(paths, target):
    return FfmpegStudioMasterRenderer(ProcessRunner()).render(
        *paths[:4],
        target,
        threading.Event(),
        performance_mix=paths[4],
        exact_stems=True,
        process_voice=True,
        adjustments=[{"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}],
    )


def _sibilant_ratio(path, backing, result):
    samples, rate = sf.read(path, always_2d=True)
    music = sf.read(backing, always_2d=True)[0]
    voice = samples / 10 ** (result.processing["delivery"]["globalGainDb"] / 20) - music
    time = np.arange(len(voice)) / rate
    middle = sum((time >= start + 0.04) & (time < start + 0.1) for start in (2, 4, 6)) > 0
    powers = []
    for band in ([250, 2000], [5000, 10000]):
        filtered = sosfilt(butter(4, band, fs=rate, btype="bandpass", output="sos"), voice, axis=0)
        powers.append(np.mean(filtered[middle] ** 2))
    return 10 * np.log10(powers[1] / powers[0])


@pytest.mark.parametrize("rate", [44100, 48000])
def test_master_uses_selective_sibilance_control_before_finishing_the_mix(
    tmp_path, rate, monkeypatch
):
    paths = _vocal_inputs(tmp_path, rate)
    before = [path.read_bytes() for path in paths]
    target = tmp_path / "master.wav"
    result = _render(paths, target)
    cleanup = result.processing["sibilanceControl"]
    assert cleanup["applied"] is True
    assert 0 < cleanup["maxReductionDb"] <= 6
    assert 0 < cleanup["affectedSeconds"] < 2
    actual, actual_rate = sf.read(target, always_2d=True)
    assert actual_rate == rate and actual.shape == (rate * 8, 2)
    assert np.isfinite(actual).all()
    assert result.processing["delivery"]["truePeakDbtp"] <= -1
    assert result.processing["gainApplications"] == 1
    # A report alone is insufficient: ignoring the returned processed path must fail.
    monkeypatch.setattr(studio_voice, "apply_sibilance_control", lambda source, *_: (source, {}))
    control = tmp_path / "without-deessing.wav"
    untreated = _render(paths, control)
    assert (
        _sibilant_ratio(target, paths[1], result)
        < _sibilant_ratio(control, paths[1], untreated) - 1
    )
    assert [path.read_bytes() for path in paths] == before
