"""Independent, evidence-based effect buses without mandatory reverberation."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, fftconvolve, sosfilt

from backend.recordings.studio_adaptive_space import render_sends


def _write(root, name, values, rate=16000):
    path = root / f"{name}.wav"
    sf.write(path, values, rate, subtype="FLOAT")
    return path


def _phrases(seconds=14, starts=(1, 3, 5, 7, 9, 11), rate=16000):
    noise = sosfilt(
        butter(2, [300, 5000], fs=rate, btype="bandpass", output="sos"),
        np.random.default_rng(33).normal(size=seconds * rate),
    )
    voice = np.zeros(seconds * rate)
    for start in starts:
        begin, end = round(start * rate), round((start + 0.5) * rate)
        voice[begin:end] = noise[begin:end] * 0.08
    return voice, noise


def _rhythm(root, noise, rate=16000):
    pulse = np.zeros(len(noise))
    for start in range(0, len(noise) - rate // 10, rate // 2):
        pulse[start : start + rate // 10] = (
            noise[start : start + rate // 10] * np.exp(-np.arange(rate // 10) / 150) * 0.1
        )
    return _write(root, "backing", pulse)


def test_reference_delay_runs_without_reverb_and_preserves_dry_onset(tmp_path):
    voice, noise = _phrases()
    expected = voice.copy()
    expected[4000:] += voice[:-4000] * 0.15
    source, reference = _write(tmp_path, "voice", voice), _write(tmp_path, "reference", expected)
    target = tmp_path / "spatial.wav"
    report = render_sends(
        source, _rhythm(tmp_path, noise), target, threading.Event(), reference=reference
    )
    assert report["applied"]
    assert set(report["buses"]) == {"delay"}
    assert report["referenceWetRatio"] == 0
    assert report["delaySeconds"] == pytest.approx(0.25, abs=0.005)
    output = sf.read(target)[0]
    np.testing.assert_array_equal(output[16000:18000], sf.read(source)[0][16000:18000])
    assert np.sqrt(np.mean(output[25000:27000] ** 2)) > 0.001
    # The measured reference has one repeat, so a second unmeasured echo is not added.
    assert np.sqrt(np.mean(output[30000:33000] ** 2)) < 1e-7
    assert len(output) == len(voice)


def test_existing_reference_delay_is_not_added_a_second_time(tmp_path):
    voice, noise = _phrases()
    voice[4000:] += voice[:-4000].copy() * 0.15
    source = _write(tmp_path, "voice", voice)
    target = tmp_path / "spatial.wav"
    report = render_sends(
        source, _rhythm(tmp_path, noise), target, threading.Event(), reference=source
    )
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])


def test_one_corroborated_diffuse_tail_is_sufficient_for_short_performance(tmp_path):
    rate = 16000
    voice, noise = _phrases(starts=(1,))
    time = np.arange(round(0.8 * rate)) / rate
    impulse = np.random.default_rng(77).normal(size=len(time)) * np.exp(-6.907755 * time / 0.8)
    impulse = sosfilt(butter(2, [250, 6000], fs=rate, btype="bandpass", output="sos"), impulse)
    impulse /= np.linalg.norm(impulse)
    impulse = np.pad(impulse, (round(0.018 * rate), 0))
    expected = voice + 0.16 * fftconvolve(voice, impulse)[: len(voice)]
    source, reference = _write(tmp_path, "voice", voice), _write(tmp_path, "reference", expected)
    target = tmp_path / "spatial.wav"
    report = render_sends(
        source, _rhythm(tmp_path, noise), target, threading.Event(), reference=reference
    )
    assert report["applied"]
    assert set(report["buses"]) == {"reverb"}
    assert report["referenceTailCount"] == 1
    assert report["decaySeconds"] == pytest.approx(0.8, abs=0.12)
    assert np.sqrt(np.mean(sf.read(target)[0][25000:27000] ** 2)) > 0.001


def test_one_fading_vowel_is_unresolved_not_an_identified_room(tmp_path):
    rate = 16000
    voice = np.zeros(rate * 5)
    local = np.arange(rate) / rate
    voice[rate : rate * 2] = 0.1 * np.sin(2 * np.pi * 220 * local)
    expected = voice.copy()
    expected[rate * 2 : rate * 3] = (
        0.1 * np.sin(2 * np.pi * 220 * local) * np.exp(-6.907755 * local / 0.8)
    )
    source, reference = _write(tmp_path, "voice", voice), _write(tmp_path, "reference", expected)
    backing = _write(
        tmp_path, "backing", np.sin(2 * np.pi * 120 * np.arange(len(voice)) / rate) * 0.1
    )
    target = tmp_path / "spatial.wav"
    report = render_sends(source, backing, target, threading.Event(), reference=reference)
    assert not report["applied"]
    assert report["reverbDecision"] == "unresolved-reference-space"
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])


@pytest.mark.parametrize("vibrato", [False, True])
def test_pitch_modulation_is_not_mistaken_for_a_short_delay(tmp_path, vibrato):
    rate = 16000
    voice, noise = _phrases()
    time = np.arange(len(voice)) / rate
    if vibrato:
        frequency = 220 * 2 ** (0.3 * np.sin(2 * np.pi * 6 * time) / 12)
        phase = 2 * np.pi * np.cumsum(frequency) / rate
        expected = np.sin(phase) + 0.4 * np.sin(2 * phase) + 0.2 * np.sin(3 * phase)
    else:
        expected = np.sin(2 * np.pi * (220 * time + 2 * time**2))
    source = _write(tmp_path, "voice", voice)
    reference = _write(tmp_path, "reference", expected * 0.05)
    target = tmp_path / "spatial.wav"
    report = render_sends(
        source, _rhythm(tmp_path, noise), target, threading.Event(), reference=reference
    )
    assert report["referenceDelayGain"] == 0
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])
