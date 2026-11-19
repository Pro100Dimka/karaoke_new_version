"""Separate regional vocal colour from capture level and the singer's phrasing."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_arrangement import ArrangementMap, ArrangementSection
from backend.recordings.studio_section_balance import plan_section_balance, render_section_tone

RATE = 8000


def _map(seconds: float, split: float | None = None) -> ArrangementMap:
    times = (np.arange(round(seconds * 4)) + 0.5) * 0.25
    boundaries = [0.0, seconds] if split is None else [0.0, split, seconds]
    sections = tuple(
        ArrangementSection(start, end, 1.0, None, start, end)
        for start, end in zip(boundaries[:-1], boundaries[1:])
    )
    yes = np.ones(len(times), dtype=bool)
    return ArrangementMap(
        round(seconds * RATE),
        RATE,
        seconds,
        times,
        np.full(len(times), 0.6),
        np.ones(len(times)),
        yes,
        yes.copy(),
        yes.copy(),
        sections,
    )


def _wave(root: Path, name: str, samples: np.ndarray) -> Path:
    path = root / f"{name}.wav"
    sf.write(path, samples, RATE, subtype="FLOAT")
    return path


def _signals(seconds: float = 24) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    time = np.arange(round(RATE * seconds)) / RATE
    body, words = np.sin(2 * np.pi * 200 * time), np.sin(2 * np.pi * 2400 * time)
    voice = 0.06 * body + 0.012 * words
    upper = np.where(time < seconds / 2, 0.012, 0.04)
    reference = np.sqrt(0.06**2 + 0.012**2 - upper**2) * body + upper * words
    return voice, reference, 0.07 * np.sin(2 * np.pi * 120 * time)


def test_reference_timbre_change_cannot_become_a_large_broadband_gain_jump(tmp_path):
    voice, reference, music = _signals()
    vocal = _wave(tmp_path, "voice", voice)
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", music)
    plan = plan_section_balance(vocal, backing, expected, backing, _map(24, 12), threading.Event())
    first = (plan.times > 3) & (plan.times < 9)
    second = (plan.times > 16) & (plan.times < 22)
    difference = float(np.median(plan.gains[second]) - np.median(plan.gains[first]))
    # Same full vocal energy, different spectral distribution: only the bounded
    # regional readability residual may change level, never the 10 dB word-band jump.
    assert abs(difference) <= 1.6
    assert np.ptp(plan.gains) <= 1.6
    assert np.max(abs(np.diff(plan.gains))) <= 0.2001


def test_own_quiet_phrase_survives_with_bounded_support_and_expression(tmp_path):
    voice, _, music = _signals()
    reference = voice.copy()
    voice[8 * RATE : 14 * RATE] *= 10 ** (-10 / 20)
    vocal = _wave(tmp_path, "voice", voice)
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", music)
    plan = plan_section_balance(vocal, backing, expected, backing, _map(24), threading.Event())
    normal = (plan.times > 3) & (plan.times < 6)
    quiet = (plan.times > 10) & (plan.times < 12)
    correction = float(np.median(plan.gains[quiet]) - np.median(plan.gains[normal]))
    assert 0 <= correction <= 3.001
    assert -10.1 <= -10 + correction <= -6.9
    assert np.isfinite(plan.gains).all()


def _harmonic_level(samples: np.ndarray, start: float, frequency: float) -> float:
    left = round(start * RATE)
    values = samples[left : left + RATE]
    basis = np.exp(-2j * np.pi * frequency * np.arange(RATE) / RATE)
    return float(abs(np.dot(values, basis)))


@pytest.mark.parametrize("scale", [1.0, 20.0])
def test_tone_is_real_linked_processing_with_float_headroom(tmp_path, scale):
    voice, reference, _ = _signals()
    source = _wave(tmp_path, "voice", scale * np.column_stack((voice, voice * 0.6)))
    expected = _wave(tmp_path, "reference", scale * np.column_stack((reference, reference * 0.6)))
    target = tmp_path / "toned.wav"
    report = render_section_tone(source, target, expected, _map(24, 12), threading.Event())
    before, rate = sf.read(source)
    after, actual_rate = sf.read(target)
    ratio_before = _harmonic_level(before[:, 0], 18, 2400) / _harmonic_level(before[:, 0], 18, 200)
    ratio_after = _harmonic_level(after[:, 0], 18, 2400) / _harmonic_level(after[:, 0], 18, 200)
    assert 20 * np.log10(ratio_after / ratio_before) > 2
    assert report["applied"]
    assert after.shape == before.shape and rate == actual_rate
    assert np.isfinite(after).all()
    np.testing.assert_allclose(after[:, 1], after[:, 0] * 0.6, atol=scale * 2e-8)
    if scale > 1:
        assert np.max(abs(after)) > 1


def test_missing_reference_preserves_capture_and_has_no_invented_tone(tmp_path):
    voice, _, music = _signals(4)
    source = _wave(tmp_path, "voice", voice)
    backing = _wave(tmp_path, "backing", music)
    target = tmp_path / "toned.wav"
    report = render_section_tone(source, target, None, _map(4), threading.Event())
    plan = plan_section_balance(source, backing, None, None, _map(4), threading.Event())
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(source)[0], sf.read(target)[0])
    np.testing.assert_array_equal(plan.gains, np.zeros_like(plan.gains))


def test_sung_dynamic_contrast_does_not_disable_capture_calibration(tmp_path):
    reference, _, music = _signals()
    reference[7 * RATE :] *= 10 ** (-15 / 20)
    vocal = _wave(tmp_path, "voice", reference * 10 ** (-8 / 20))
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", music)
    plan = plan_section_balance(vocal, backing, expected, backing, _map(24), threading.Event())
    assert plan.report["referenceUsed"]
    assert np.median(plan.gains) == pytest.approx(8, abs=0.15)


def test_one_reference_syllable_cannot_calibrate_a_whole_performance(tmp_path):
    voice, _, music = _signals()
    reference = np.zeros_like(voice)
    reference[RATE : round(1.3 * RATE)] = voice[RATE : round(1.3 * RATE)]
    vocal = _wave(tmp_path, "voice", voice * 0.4)
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", music)
    plan = plan_section_balance(vocal, backing, expected, backing, _map(24), threading.Event())
    assert not plan.report["referenceUsed"]
    np.testing.assert_array_equal(plan.gains, np.zeros_like(plan.gains))


def test_matching_short_phrase_preserves_capture_calibration(tmp_path):
    reference, _, music = _signals(3)
    time = np.arange(len(reference)) / RATE
    reference *= (time >= 1) & (time < 1.2)
    vocal = _wave(tmp_path, "voice", reference * 0.1)
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", music)
    plan = plan_section_balance(vocal, backing, expected, backing, _map(3), threading.Event())
    assert plan.report["referenceUsed"]
    assert plan.report["referenceMatchedFraction"] == pytest.approx(1)
    assert np.median(plan.gains[plan.active]) == pytest.approx(20, abs=0.15)


def test_supported_word_deficit_gets_spectral_support_not_broadband_gain(tmp_path):
    voice, reference, music = _signals()
    voice[:RATE] = voice[-RATE:] = 0
    reference[:RATE] = reference[-RATE:] = 0
    source = _wave(tmp_path, "voice", voice)
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", music)
    target = tmp_path / "toned.wav"
    report = render_section_tone(source, target, expected, _map(24, 12), threading.Event())
    after, _ = sf.read(target)
    before_ratio = _harmonic_level(voice, 18, 2400) / _harmonic_level(voice, 18, 200)
    after_ratio = _harmonic_level(after, 18, 2400) / _harmonic_level(after, 18, 200)
    assert 20 * np.log10(after_ratio / before_ratio) > 5
    assert report["maxGainPerBandDb"] <= 4
    plan = plan_section_balance(target, backing, expected, backing, _map(24, 12), threading.Event())
    gain = float(np.median(plan.gains[(plan.times > 16) & (plan.times < 22)]))
    full_change = 20 * np.log10(
        np.linalg.norm(after[16 * RATE : 22 * RATE]) / np.linalg.norm(voice[16 * RATE : 22 * RATE])
    )
    assert gain + full_change <= 1.6


def test_stationary_word_band_noise_cannot_justify_presence_boost(tmp_path):
    time = np.arange(24 * RATE) / RATE
    spoken = (time >= 1) & (time < 23)
    noise = np.random.default_rng(411).normal(0, 0.001, len(time))
    body, words = np.sin(2 * np.pi * 200 * time), np.sin(2 * np.pi * 2400 * time)
    source = _wave(tmp_path, "voice", spoken * (0.06 * body + 0.0003 * words) + noise)
    expected = _wave(tmp_path, "reference", spoken * (0.045 * body + 0.04 * words))
    target = tmp_path / "toned.wav"
    report = render_section_tone(source, target, expected, _map(24), threading.Event())
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(source)[0], sf.read(target)[0])


@pytest.mark.parametrize("body_frequency,capture_gain", [(150, 1.0), (400, 1.0), (150, 0.05)])
def test_capture_anchor_rejects_bass_colour_and_tracks_recording_gain(
    tmp_path, body_frequency, capture_gain
):
    time = np.arange(8 * RATE) / RATE
    body = np.sin(2 * np.pi * body_frequency * time)
    words = 0.035 * np.sin(2 * np.pi * 900 * time) + 0.02 * np.sin(2 * np.pi * 1800 * time)
    singing = (time >= 1) & (time < 7)
    vocal = _wave(tmp_path, "voice", capture_gain * (0.12 * body + words) * singing)
    reference = _wave(tmp_path, "reference", (0.015 * body + words) * singing)
    backing = _wave(tmp_path, "backing", 0.07 * np.sin(2 * np.pi * 120 * time))
    plan = plan_section_balance(vocal, backing, reference, backing, _map(8), threading.Event())
    assert plan.report["referenceUsed"]
    np.testing.assert_allclose(plan.gains, -20 * np.log10(capture_gain), atol=0.2)


def test_two_correlated_presence_bands_cannot_copy_reference_tone_into_section_gain(tmp_path):
    time = np.arange(24 * RATE) / RATE
    body = np.sin(2 * np.pi * 200 * time)
    lower = np.sin(2 * np.pi * 900 * time)
    upper = np.sin(2 * np.pi * 2400 * time)
    voice = 0.1 * body + 0.018 * lower + 0.012 * upper
    color = np.where(time < 12, 1.0, 2.0)
    reference = np.sqrt(0.1**2 + (1 - color**2) * (0.018**2 + 0.012**2)) * body
    reference += color * (0.018 * lower + 0.012 * upper)
    vocal = _wave(tmp_path, "voice", voice)
    expected = _wave(tmp_path, "reference", reference)
    backing = _wave(tmp_path, "backing", 0.07 * np.sin(2 * np.pi * 120 * time))
    plan = plan_section_balance(vocal, backing, expected, backing, _map(24, 12), threading.Event())
    assert plan.report["referenceUsed"]
    assert plan.report["captureAnchorMethod"] == "take-wide-supported-band-consensus"
    first = (plan.times > 3) & (plan.times < 9)
    second = (plan.times > 16) & (plan.times < 22)
    assert abs(np.median(plan.gains[second]) - np.median(plan.gains[first])) <= 1.6
