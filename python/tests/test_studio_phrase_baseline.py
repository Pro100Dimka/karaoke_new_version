"""Quiet pitched tails must not raise unchanged audible word bodies."""

import threading

import numpy as np
import pytest
from scipy.signal import butter, sosfilt
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import build_gain_plan
from backend.recordings.studio_delivery import measure_mix_loudness
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _harmonic(time):
    return sum(np.sin(2 * np.pi * 140 * partial * time) / partial for partial in (1, 2, 3))


def _render(root, rate, voice, reference, *, verified=True):
    root.mkdir()
    time = np.arange(len(voice)) / rate
    music = 0.05 * np.sin(2 * np.pi * 900 * time)
    paths = [root / f"{name}.wav" for name in ("voice", "reference", "backing", "output")]
    for path, samples in zip(paths, (voice, reference, music)):
        sf.write(path, samples, rate, subtype="FLOAT")
    originals = [path.read_bytes() for path in paths[:3]]
    renderer, cancel = FfmpegStudioMasterRenderer(ProcessRunner()), threading.Event()
    rv, rb = measure_mix_loudness(renderer, paths[1], paths[2], cancel)
    times = (np.arange(len(rv)) + 1) * 0.1 - 0.2
    plan = build_gain_plan(
        renderer,
        paths[0],
        paths[2],
        0.5,
        cancel,
        reference_balance=(times, rv, rb),
        reference_level_correction_db=0 if verified else None,
    )
    _write_gain_envelope(paths[0], paths[3], plan.times, plan.gains, cancel)
    output, actual_rate = sf.read(paths[3])
    assert actual_rate == rate and output.shape == voice.shape
    assert np.isfinite(output).all()
    assert [path.read_bytes() for path in paths[:3]] == originals
    assert plan.report["baselineMethod"] == (
        "voiced-power-with-local-peak-bound" if verified else "voiced-log-mean"
    )
    assert plan.report["balanceBasis"] == (
        "verified-source-reference" if verified else "uncalibrated-reference-fallback"
    )
    return output, plan


def _level(samples):
    return 10 * np.log10(np.mean(samples**2))


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("duty", [0.5, 0.75])
def test_quieter_pitched_tails_do_not_raise_the_same_sung_words(tmp_path, rate, duty):
    time = np.arange(rate * 16) / rate
    carrier = 0.05 * _harmonic(time)
    phrase = (time >= 3) & (time < 13)
    phase = np.remainder(time - 3, 0.8)
    word = phase < 0.8 * duty
    room = np.random.default_rng(2105).normal(0, 1e-5, len(time))
    reference = np.where(phrase, carrier, room)
    heard = phrase & (time >= 5) & (time < 11) & (phase >= 0.1) & (phase < 0.8 * duty - 0.1)
    levels = []
    plans = []
    for tail_db in (-18, -36):
        voice = np.where(phrase, carrier * np.where(word, 1, 10 ** (tail_db / 20)), room)
        output, plan = _render(tmp_path / str(tail_db), rate, voice, reference)
        # Compare the exact unchanged word bodies, not total track RMS: lowering
        # already quiet pitched tails must not turn up the audible words.
        levels.append(_level(output[heard]))
        plans.append(plan)
    np.testing.assert_array_equal(plans[0].active, plans[1].active)
    assert abs(levels[1] - levels[0]) < 0.75


@pytest.mark.parametrize("rate", [44100, 48000])
def test_a_sustained_quiet_reference_phrase_remains_quiet_and_supported(tmp_path, rate):
    time = np.arange(rate * 24) / rate
    phrase = (time >= 2) & (time < 22)
    quiet = time >= 12
    voice = 0.05 * _harmonic(time) * phrase * np.where(quiet, 10 ** (-12 / 20), 1)
    output, plan = _render(tmp_path / "quiet", rate, voice, voice.copy())
    first, second = (time >= 6) & (time < 9), (time >= 16) & (time < 19)
    assert _level(output[second]) - _level(output[first]) == pytest.approx(-12, abs=0.4)
    late = (plan.times >= 16) & (plan.times < 19)
    assert plan.active[late].all()


@pytest.mark.parametrize("duration", [0.02, 0.2])
def test_verified_placement_does_not_anticipate_an_isolated_loud_syllable(tmp_path, duration):
    rate = 48000
    time = np.arange(rate * 8) / rate
    reference = 0.05 * _harmonic(time)
    voice = reference.copy()
    voice[(time >= 4) & (time < 4 + duration)] *= 8
    output, _ = _render(tmp_path / "accent", rate, voice, reference)
    steady = (time >= 2) & (time < 3)
    before = (time >= 3.94) & (time < 3.98)
    steady_gain = _level(output[steady]) - _level(voice[steady])
    before_gain = _level(output[before]) - _level(voice[before])
    assert abs(before_gain - steady_gain) < 0.75


@pytest.mark.parametrize("rate", [44100, 48000])
def test_verified_placement_preserves_modest_expression(tmp_path, rate):
    time = np.arange(rate * 12) / rate
    reference = 0.05 * np.sin(2 * np.pi * 700 * time)
    voice = reference * 10 ** (6 * np.sin(2 * np.pi * 0.5 * time) / 20)
    output, _ = _render(tmp_path / "expression", rate, voice, reference)
    spans = []
    for samples in (voice, output):
        frames = samples[2 * rate : 10 * rate].reshape(-1, round(rate * 0.02))
        levels = 10 * np.log10(np.mean(frames**2, axis=1))
        spans.append(np.ptp(np.percentile(levels, [10, 90])))
    assert 0.5 * spans[0] <= spans[1] <= spans[0] + 0.5


@pytest.mark.parametrize("rate", [44100, 48000])
def test_verified_placement_still_supports_a_quiet_harmonic_word(tmp_path, rate):
    time = np.arange(rate * 8) / rate
    reference = sum(
        0.025 / partial * np.sin(2 * np.pi * 140 * partial * time) for partial in range(1, 9)
    )
    voice = reference.copy()
    voice[(time >= 4) & (time < 4.4)] *= 0.2
    output, _ = _render(tmp_path / "word", rate, voice, reference)
    steady = (time >= 1) & (time < 2)
    quiet = (time >= 4.1) & (time < 4.3)
    assert _level(output[quiet]) - _level(output[steady]) > -4


def test_unverified_reference_retains_the_legacy_baseline(tmp_path, monkeypatch):
    from backend.recordings import studio_calibration

    def unexpected(*args, **kwargs):
        raise AssertionError("An unverified source must retain its existing fallback baseline")

    monkeypatch.setattr(studio_calibration, "_placement_baseline", unexpected)
    rate = 44100
    time = np.arange(rate * 8) / rate
    voice = 0.05 * _harmonic(time)
    _, plan = _render(tmp_path / "fallback", rate, voice, voice.copy(), verified=False)
    assert plan.report["vocalLiftDb"] == 1.5


def _sparse_voice(time, rate, accent_db):
    envelope = ((time < 3) | (time >= 11)).astype(float)
    for index, duration in enumerate((0.08, 0.15, 0.28, 0.12, 0.32, 0.1, 0.18, 0.24, 0.15)):
        start = 3.5 + index * 0.8
        attack = np.clip((time - start) / 0.005, 0, 1)
        release = np.clip((start + duration - time) / 0.005, 0, 1)
        gain = 10 ** (accent_db / 20) if index == 1 else 1
        envelope = np.maximum(envelope, np.minimum(attack, release) * gain)
    noise = sosfilt(
        butter(2, [500, 3400], fs=rate, btype="bandpass", output="sos"),
        np.random.default_rng(73).normal(size=len(time)),
    )
    noise *= (0.05 / np.sqrt(2) * 10 ** (-18 / 20)) / np.sqrt(np.mean(noise**2))
    return 0.05 * np.sin(2 * np.pi * 700 * time) * envelope + noise * (1 - np.minimum(envelope, 1))


@pytest.mark.parametrize("rate", [44100, 48000])
def test_sparse_loud_word_does_not_lower_the_previous_unchanged_word(tmp_path, rate):
    time = np.arange(rate * 14) / rate
    reference = _sparse_voice(time, rate, 0)
    before = (time >= 3.52) & (time < 3.56)
    gains = []
    for accent in (0, 12):
        voice = _sparse_voice(time, rate, accent)
        output, _ = _render(tmp_path / str(accent), rate, voice, reference)
        np.testing.assert_array_equal(voice[before], reference[before])
        gains.append(_level(output[before]) - _level(voice[before]))
        if accent:
            peak = (time >= 4.32) & (time < 4.43)
            steady = (time >= 1) & (time < 2)
            assert _level(output[peak]) - _level(output[steady]) < 4
    assert abs(gains[1] - gains[0]) < 0.75
