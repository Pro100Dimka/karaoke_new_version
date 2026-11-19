"""A pitched soft word must not lose its leveling solely because it is breathy."""

import json
import threading

import numpy as np
import pytest
from scipy.signal import butter, sosfilt
import soundfile as sf

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import _voicing_profile, build_gain_plan
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _level(samples):
    return float(10 * np.log10(max(float(np.mean(samples**2)), 1e-20)))


def _phrase(rate, kind, frequency=140, formants=False):
    time = np.arange(rate * 8) / rate
    harmonic = np.zeros_like(time)
    for partial in range(1, 17 if formants else 9):
        hz = frequency * partial
        weight = 1 / partial
        if formants:
            weight *= 1 + 2 * np.exp(-0.5 * ((hz - 700) / 180) ** 2)
            weight += 0.1 * np.exp(-0.5 * ((hz - 1400) / 250) ** 2)
        harmonic += weight * np.sin(2 * np.pi * hz * time)
    harmonic *= 0.035 / np.sqrt(np.mean(harmonic**2))
    core = (time >= 4.08) & (time < 4.32)
    noise = sosfilt(
        butter(
            2,
            [50, 400] if kind == "low_noise" else [500, 3400],
            fs=rate,
            btype="bandpass",
            output="sos",
        ),
        np.random.default_rng(73).normal(size=len(time)),
    )
    noise *= np.sqrt(np.mean(harmonic[core] ** 2) / np.mean(noise[core] ** 2))
    word = harmonic.copy()
    if kind == "breathy":
        # The periodic voice has four times the noise power: this is a sung
        # word with breath, not a breath substituted for an absent voice.
        word += noise * 10 ** (-6 / 20)
    elif kind in {"hum_breath", "hum60_breath"}:
        hum = np.sin(2 * np.pi * (60 if kind == "hum60_breath" else 50) * time)
        hum *= np.sqrt(np.mean(harmonic[core] ** 2) / np.mean(hum[core] ** 2))
        word = hum + noise * 10 ** (-12 / 20)
    elif kind in {"breath", "low_noise"}:
        word = noise
    word *= 0.035 / np.sqrt(np.mean(word[core] ** 2))
    word *= 10 ** (-12 / 20)
    blend = np.minimum(np.clip((time - 4) / 0.01, 0, 1), np.clip((4.4 - time) / 0.01, 0, 1))
    return time, harmonic * (1 - blend) + word * blend


def _render(root, rate, kind, frequency=140, formants=False):
    time, voice = _phrase(rate, kind, frequency, formants)
    source, backing, output = [root / f"{kind}-{name}.wav" for name in ["voice", "music", "out"]]
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(backing, 0.05 * np.sin(2 * np.pi * 900 * time), rate, subtype="FLOAT")
    original = source.read_bytes()
    cancel = threading.Event()
    plan = build_gain_plan(
        FfmpegStudioMasterRenderer(ProcessRunner()), source, backing, 0.5, cancel
    )
    _write_gain_envelope(source, output, plan.times, plan.gains, cancel)
    actual, actual_rate = sf.read(output)
    assert actual_rate == rate and actual.shape == voice.shape
    assert np.isfinite(actual).all()
    assert source.read_bytes() == original
    word = (time >= 4.08) & (time < 4.32)
    body = (time >= 1) & (time < 2)
    profile = _voicing_profile(source, cancel)
    positions = (np.arange(len(profile)) + 0.5) * 0.04
    confidence = profile[(positions >= 4.08) & (positions < 4.32)]
    metrics = {
        "kind": kind,
        "rate": rate,
        "frequency": frequency,
        "formants": formants,
        "input_word_vs_body_db": _level(voice[word]) - _level(voice[body]),
        "output_word_vs_body_db": _level(actual[word]) - _level(actual[body]),
        "word_gain_db": _level(actual[word]) - _level(voice[word]),
        "body_gain_db": _level(actual[body]) - _level(voice[body]),
        "confidence_median": float(np.median(confidence)),
        "confidence_min": float(np.min(confidence)),
        "protection": plan.report["unvoicedProtection"],
    }
    print(json.dumps(metrics, sort_keys=True))
    return metrics


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize(
    "frequency,formants", [(70, False), (90, False), (110, True), (140, False), (220, True)]
)
def test_breathy_soft_word_retains_the_leveling_of_a_clean_pitched_word(
    tmp_path, rate, frequency, formants
):
    clean = _render(tmp_path, rate, "clean", frequency, formants)
    breathy = _render(tmp_path, rate, "breathy", frequency, formants)
    assert clean["input_word_vs_body_db"] == pytest.approx(-12, abs=0.05)
    assert breathy["input_word_vs_body_db"] == pytest.approx(
        clean["input_word_vs_body_db"], abs=0.01
    )
    assert clean["output_word_vs_body_db"] > -4
    # A modest noise component must not forfeit the level support already given
    # to a word with the same pitch, duration, input level and accompaniment.
    assert breathy["output_word_vs_body_db"] > clean["output_word_vs_body_db"] - 2


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("kind", ["breath", "low_noise", "hum_breath", "hum60_breath"])
@pytest.mark.parametrize("frequency", [70, 140, 220])
def test_pure_noise_at_the_same_level_is_not_lifted_as_a_word(tmp_path, rate, kind, frequency):
    breath = _render(tmp_path, rate, kind, frequency)
    assert breath["input_word_vs_body_db"] == pytest.approx(-12, abs=0.05)
    assert breath["output_word_vs_body_db"] <= breath["input_word_vs_body_db"] + 2
    assert breath["word_gain_db"] >= -8


@pytest.mark.parametrize("rate", [44100, 48000])
def test_periodic_low_voice_does_not_drop_confidence_at_the_search_boundary(tmp_path, rate):
    _, voice = _phrase(rate, "clean", frequency=70)
    path = tmp_path / "low-voice.wav"
    # Every analysis frame contains the same perfectly periodic sound; its
    # position within the waveform's cycle is not evidence for a breath.
    sf.write(path, voice[: rate * 2], rate, subtype="FLOAT")
    confidence = _voicing_profile(path, threading.Event())
    assert np.min(confidence) > 0.85
