"""Vocal evidence must not depend on the brightness used to measure its balance."""

from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.recordings.studio_adaptive_balance import plan_balance


RATE = 8000


def _plan(root: Path, voice: np.ndarray, reference: np.ndarray):
    time = np.arange(len(voice)) / RATE
    backing = 0.07 * np.sin(2 * np.pi * 160 * time)
    paths = [root / f"{name}.wav" for name in ("voice", "reference", "backing")]
    for path, data in zip(paths, (voice, reference, backing), strict=True):
        sf.write(path, data, RATE, subtype="FLOAT")
    return plan_balance(paths[0], paths[2], paths[1], paths[2], threading.Event())


@pytest.mark.parametrize("swap_singers", [False, True])
def test_strong_dark_vowels_contribute_to_the_phrase_balance(tmp_path, swap_singers):
    time = np.arange(RATE * 24) / RATE
    body = np.sin(2 * np.pi * 150 * time)
    words = np.sin(2 * np.pi * 1200 * time)
    # The second section alternates dark and bright vowels. Both have a strong
    # fundamental; only the word-band contrast differs between the singers.
    dark = (time >= 12) & (time % 1.5 < 1.0)
    voice = 0.06 * body + np.where(dark, 0.008, 0.04) * words
    reference = 0.02 * body + np.where(dark, 0.016, 0.04) * words
    direction = 1
    if swap_singers:
        voice, reference = reference, voice
        direction = -1
    plan = _plan(tmp_path, voice, reference)
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] == 1.0
    first = (plan.times > 2) & (plan.times < 8)
    second = (plan.times > 19) & (plan.times < 23)
    assert np.median(plan.gains[first]) == pytest.approx(0, abs=0.3)
    assert np.median(plan.gains[second]) == pytest.approx(direction * 6.0206, abs=0.7)
    assert np.max(abs(np.diff(plan.gains))) <= 0.2001


def test_broadband_rumble_without_word_band_evidence_cannot_set_a_target(tmp_path):
    time = np.arange(RATE * 20) / RATE
    body = np.sin(2 * np.pi * 150 * time)
    words = np.sin(2 * np.pi * 1200 * time)
    phrase = (time >= 1) & (time < 19)
    singing = phrase & ~((time >= 8) & (time < 14))
    # A stationary low-frequency signal remains through the missing performance.
    # It is strong enough to pass a broadband activity gate, but contains no words.
    voice = 0.06 * body * phrase + 0.04 * words * singing
    reference = (0.04 * body + 0.08 * words) * phrase
    plan = _plan(tmp_path, voice, reference)
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] == 1.0
    middle = (plan.times > 9.5) & (plan.times < 12.5)
    np.testing.assert_allclose(plan.gains[middle], 6.0206, atol=0.3)


def _noise_band(size: int, low: float, high: float) -> np.ndarray:
    noise = np.random.default_rng(4926).normal(size=size)
    filtered = sosfilt(butter(4, (low, high), btype="bandpass", fs=RATE, output="sos"), noise)
    return filtered / np.sqrt(np.mean(filtered**2))


@pytest.mark.parametrize("periodic_side", [False, True])
def test_aperiodic_reference_low_end_cannot_duck_continuing_words(tmp_path, periodic_side):
    time = np.arange(RATE * 24) / RATE
    body = np.sin(2 * np.pi * 150 * time)
    words = np.sin(2 * np.pi * 1200 * time)
    voice = 0.02 * body + 0.04 * words
    missing = (time >= 8) & (time < 14)
    # Separation residue is strong in the lows and above the band noise floor,
    # but it is neither a bright word nor a periodic dark sung vowel.
    residue = 0.04 * _noise_band(len(time), 50, 450) + 0.002 * words
    reference = np.where(missing, residue, voice)
    if periodic_side:
        side = 0.2 * body * missing
        reference = np.column_stack((reference + side, reference - side))
    plan = _plan(tmp_path, voice, reference)
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] == 1.0
    middle = (plan.times > 9.5) & (plan.times < 12.5)
    np.testing.assert_allclose(plan.gains[middle], 0, atol=0.3)


def test_clear_aperiodic_words_survive_a_drop_in_broadband_body(tmp_path):
    time = np.arange(RATE * 24) / RATE
    body = np.sin(2 * np.pi * 150 * time)
    words = _noise_band(len(time), 1000, 3000)
    second = time >= 12
    # The later clear consonants lose the strong fundamental, so a mandatory
    # broadband core would discard useful word-band evidence and hold stale gain.
    voice = np.where(second, 0.001, 0.16) * body + np.where(second, 0.012, 0.02) * words
    reference = 0.02 * body + np.where(second, 0.006, 0.02) * words
    plan = _plan(tmp_path, voice, reference)
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] == 1.0
    settled = (plan.times > 19) & (plan.times < 23)
    assert np.median(plan.gains[settled]) == pytest.approx(-6.0206, abs=0.3)
