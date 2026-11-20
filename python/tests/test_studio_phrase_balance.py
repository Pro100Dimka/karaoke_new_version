"""Different singers' articulation must not become automatic volume dips."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_adaptive_balance import plan_balance


RATE = 8000


def _plan(root: Path, voice: np.ndarray, reference: np.ndarray, backing=None):
    time = np.arange(len(voice)) / RATE
    if backing is None:
        backing = 0.07 * np.sin(2 * np.pi * 160 * time)
    paths = [root / f"{name}.wav" for name in ("voice", "reference", "backing")]
    for path, data in zip(paths, (voice, reference, backing), strict=True):
        sf.write(path, data, RATE, subtype="FLOAT")
    return plan_balance(paths[0], paths[2], paths[1], paths[2], threading.Event())


def test_reference_release_cannot_duck_a_continuing_performance(tmp_path):
    time = np.arange(RATE * 8) / RATE
    voice = 0.03 * np.sin(2 * np.pi * 900 * time)
    release = np.where(time < 4, 1.0, np.exp(-12 * (time - 4)))
    release[time > 4.8] = 0
    plan = _plan(tmp_path, voice, 2 * voice * release)
    assert plan.report["referenceUsed"]
    np.testing.assert_allclose(plan.gains[plan.active], 6.0206, atol=0.3)
    assert np.max(abs(np.diff(plan.gains[plan.active]))) < 0.21


@pytest.mark.parametrize("gap", [2, 10])
def test_long_pause_does_not_carry_the_previous_reference_release(tmp_path, gap):
    second = 4.5 + gap
    time = np.arange(round(RATE * (second + 4))) / RATE
    carrier = 0.03 * np.sin(2 * np.pi * 900 * time)
    phrases = ((time >= 1) & (time < 4.5)) | ((time >= second) & (time < second + 3.5))
    voice = carrier * phrases
    reference = 2 * voice.copy()
    reference[(time >= 3) & (time < 4.5)] *= np.exp(-10 * (time[(time >= 3) & (time < 4.5)] - 3))
    reference[(time >= second) & (time < second + 0.15)] *= 10 ** (-30 / 20)
    plan = _plan(tmp_path, voice, reference)
    attack = (plan.times >= second) & (plan.times < second + 0.6)
    np.testing.assert_allclose(plan.gains[attack], 6.0206, atol=0.3)
    np.testing.assert_array_equal(
        voice[~phrases] * 10 ** (plan.report["inputCalibrationDb"] / 20), 0
    )


def test_shifted_dark_phonemes_do_not_switch_the_balance_band(tmp_path):
    time = np.arange(RATE * 9) / RATE
    body = np.sin(2 * np.pi * 150 * time)
    words = 0.04 * np.sin(2 * np.pi * 1200 * time)
    # Both performances have the same word-band level, with different consonant timing.
    actual_words = words * np.where((time % 1) < 0.2, 0.04, 1)
    reference_words = words * np.where(((time + 0.4) % 1) < 0.2, 0.04, 1)
    plan = _plan(tmp_path, 0.16 * body + actual_words, 0.02 * body + reference_words)
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] > 0.95
    assert len(plan.report["anchorRegions"]) == 1
    np.testing.assert_allclose(plan.gains[plan.active], 0, atol=0.6)


def test_phrase_balance_still_follows_a_sustained_level_change(tmp_path):
    time = np.arange(RATE * 24) / RATE
    reference = 0.03 * np.sin(2 * np.pi * 900 * time)
    voice = reference * np.where(time < 12, 2.0, 1.0)
    plan = _plan(tmp_path, voice, reference)
    before = (plan.times > 3) & (plan.times < 9)
    after = (plan.times > 19) & (plan.times < 23)
    assert np.median(plan.gains[before]) == pytest.approx(-6.0206, abs=0.2)
    assert np.median(plan.gains[after]) == pytest.approx(0, abs=0.2)
    assert np.max(abs(np.diff(plan.gains))) <= 0.2001


def test_unmatched_new_phrase_keeps_only_the_trusted_input_calibration(tmp_path):
    time = np.arange(RATE * 12) / RATE
    voice = 0.03 * np.sin(2 * np.pi * 900 * time)
    voice[(time >= 7) & (time < 9)] = 0
    reference = 2 * voice.copy()
    reference[time >= 7] = 0
    plan = _plan(tmp_path, voice, reference)
    unmatched = (plan.times >= 9) & plan.active
    np.testing.assert_allclose(plan.gains[unmatched], 6.0206, atol=0.1)
    assert plan.report["inputCalibrationDb"] == pytest.approx(6.0206, abs=0.1)


def test_reference_residue_cannot_set_a_target_for_an_unmatched_phrase(tmp_path):
    time = np.arange(RATE * 12) / RATE
    voice = 0.03 * np.sin(2 * np.pi * 900 * time)
    voice[(time >= 7) & (time < 9)] = 0
    reference = 2 * voice.copy()
    # A residual 28 dB below the real lead is not evidence of a softly sung line.
    reference[time >= 7] = 0.06 * 10 ** (-28 / 20) * np.sin(2 * np.pi * 1200 * time[time >= 7])
    plan = _plan(tmp_path, voice, reference)
    np.testing.assert_allclose(plan.gains[plan.times >= 9], 6.0206, atol=0.3)


def test_common_backing_does_not_bias_differently_timed_syllables(tmp_path):
    time = np.arange(RATE * 12) / RATE
    carrier = 0.03 * np.sin(2 * np.pi * 900 * time)
    voice = carrier * np.where((time % 1) < 0.5, 1.0, 0.04)
    reference = 2 * carrier * np.where((time % 1) < 0.5, 0.04, 1.0)
    music = 0.05 * np.sin(2 * np.pi * 160 * time)
    music *= np.where((time % 1) < 0.5, 1.0, 0.05)
    plan = _plan(tmp_path, voice, reference, music)
    np.testing.assert_allclose(plan.gains[plan.active], 6.0206, atol=0.3)


def test_small_support_change_cannot_switch_the_level_scale(tmp_path):
    time = np.arange(RATE * 11) / RATE
    body = np.sin(2 * np.pi * 150 * time)
    words = 0.04 * np.sin(2 * np.pi * 1200 * time)
    support = np.where(time < 5, 0.55, 0.65)
    words *= np.where((time % 1) < support, 1.0, 0.02)
    voice, reference = 0.16 * body + words, 0.02 * body + words
    voice[(time >= 5) & (time < 6)] = 0
    reference[(time >= 5) & (time < 6)] = 0
    plan = _plan(tmp_path, voice, reference)
    first = (plan.times > 1) & (plan.times < 4)
    second = (plan.times > 7) & (plan.times < 10)
    assert abs(np.median(plan.gains[first]) - np.median(plan.gains[second])) < 1


def test_input_calibration_survives_a_very_quiet_continuing_vowel(tmp_path):
    time = np.arange(RATE * 8) / RATE
    voice = 0.03 * np.sin(2 * np.pi * 900 * time)
    voice[time > 5] *= 0.01
    reference = 2 * voice.copy()
    plan = _plan(tmp_path, voice, reference)
    np.testing.assert_allclose(plan.gains[plan.times > 5.5], 6.0206, atol=0.1)


def test_first_word_uses_the_full_available_phrase_context(tmp_path):
    time = np.arange(RATE * 8) / RATE
    voice = 0.03 * np.sin(2 * np.pi * 900 * time)
    reference = 2 * voice.copy()
    reference[time < 1.4] *= 0.3
    plan = _plan(tmp_path, voice, reference)
    # The user's stable onset must not imitate the reference's weaker articulation.
    np.testing.assert_allclose(plan.gains[plan.times < 3], 6.0206, atol=0.3)


def test_missing_reference_section_holds_gain_until_evidence_returns(tmp_path):
    time = np.arange(RATE * 18) / RATE
    voice = 0.03 * np.sin(2 * np.pi * 900 * time)
    reference = voice.copy()
    reference[(time >= 6) & (time < 12)] = 0
    reference[time >= 12] *= 2
    plan = _plan(tmp_path, voice, reference)
    gap = (plan.times > 7) & (plan.times < 11)
    np.testing.assert_allclose(plan.gains[gap], 0, atol=0.2)
    assert np.median(plan.gains[plan.times > 16]) == pytest.approx(6.0206, abs=0.2)
