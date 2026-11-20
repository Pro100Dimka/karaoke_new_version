"""Numerical contracts for the adaptive master, independent of listening claims."""

import json
import threading
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_adaptive_mix import plan_balance, duck_backing, mix_and_master
from backend.recordings.studio_adaptive_space import estimate_tempo, render_sends
from backend.recordings.studio_adaptive_delivery import deliver_master


def wave(root: Path, name: str, samples: np.ndarray, rate: int = 16000) -> Path:
    path = root / f"{name}.wav"
    sf.write(path, samples, rate, subtype="FLOAT")
    return path


def tone(seconds: float = 4, hz: float = 220, gain: float = 0.1, rate: int = 16000):
    return gain * np.sin(2 * np.pi * hz * np.arange(round(seconds * rate)) / rate)


def test_absolute_reference_ratio_changes_balance_without_recentering(tmp_path):
    cancel = threading.Event()
    vocal = wave(tmp_path, "vocal", tone())
    backing = wave(tmp_path, "backing", tone(hz=120))
    gains = []
    for expected in (-8.0, 4.0):
        reference = wave(tmp_path, f"ref{expected}", tone(gain=0.1 * 10 ** (expected / 20)))
        plan = plan_balance(vocal, backing, reference, backing, cancel)
        gains.append(float(np.median(plan.gains[plan.active])))
        assert plan.report["referenceMatchedSeconds"] >= 3
    assert gains[1] - gains[0] == pytest.approx(12, abs=0.3)
    assert gains == pytest.approx([-8, 4], abs=0.3)


def test_reference_gain_is_not_faded_at_recording_boundaries(tmp_path):
    vocal = wave(tmp_path, "vocal", tone())
    backing = wave(tmp_path, "backing", tone(hz=120))
    reference = wave(tmp_path, "reference", tone(gain=0.025))
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    np.testing.assert_allclose(plan.gains, -12.0412, atol=0.001)


@pytest.mark.parametrize("body_hz", [150, 400])
def test_excess_low_body_cannot_turn_down_already_matching_word_bands(tmp_path, body_hz):
    words = tone(hz=900, gain=0.035) + tone(hz=1800, gain=0.02)
    vocal = wave(tmp_path, "vocal", tone(hz=body_hz, gain=0.12) + words)
    reference = wave(tmp_path, "reference", tone(hz=body_hz, gain=0.015) + words)
    backing = wave(tmp_path, "backing", tone(hz=900, gain=0.05) + tone(hz=1800, gain=0.03))
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    assert abs(np.median(plan.gains[plan.active])) < 1
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] > 0.9
    assert plan.report["referenceSpectralAnchor"]["presenceFraction"] > 0.9


@pytest.mark.parametrize("hz", [50, 65, 110])
def test_low_voice_without_readability_band_uses_broadband_reference(tmp_path, hz):
    vocal = wave(tmp_path, "vocal", tone(hz=hz))
    reference = wave(tmp_path, "reference", tone(hz=hz, gain=0.05))
    backing = wave(tmp_path, "backing", tone(hz=120))
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    np.testing.assert_allclose(plan.gains, -6.0206, atol=0.01)
    assert plan.report["voiceSpectralAnchor"]["presenceFraction"] == 0


def test_continuing_vocal_does_not_jump_when_both_backings_pause(tmp_path):
    vocal = wave(tmp_path, "vocal", tone(seconds=8, hz=900, gain=0.09))
    reference = wave(tmp_path, "reference", tone(seconds=8, hz=900, gain=0.03))
    music = tone(seconds=8, hz=160, gain=0.05)
    music[64000:96000] = 0
    backing = wave(tmp_path, "backing", music)
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    np.testing.assert_allclose(plan.gains, -9.542425, atol=0.01)


@pytest.mark.parametrize("with_pauses", [False, True])
def test_clean_quiet_capture_has_calibration_separate_from_local_boost(tmp_path, with_pauses):
    signal = tone(seconds=4, hz=900, gain=0.01)
    if with_pauses:
        signal[16000:24000] = 0
        signal[48000:56000] = 0
    vocal = wave(tmp_path, "vocal", signal)
    reference = wave(tmp_path, "reference", signal * 10)
    backing = wave(tmp_path, "backing", tone(hz=120))
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    np.testing.assert_allclose(plan.gains[plan.active], 20, atol=0.05)
    # The established input calibration remains constant through exact silence.
    np.testing.assert_allclose(plan.gains, 20, atol=0.05)
    assert plan.report["inputCalibrationDb"] == pytest.approx(20, abs=0.05)
    assert plan.report["localAutomationLimitDb"] <= 9
    assert plan.report["totalGainLimitDb"] >= 20


@pytest.mark.parametrize("with_pauses", [False, True])
def test_uncertain_noise_capture_does_not_receive_large_calibration(tmp_path, with_pauses):
    signal = np.random.default_rng(8).normal(size=64000) * 0.007
    reference_signal = tone(seconds=4, hz=900, gain=0.1)
    if with_pauses:
        signal[16000:24000] = reference_signal[16000:24000] = 0
        signal[48000:56000] = reference_signal[48000:56000] = 0
    vocal = wave(tmp_path, "vocal", signal)
    reference = wave(tmp_path, "reference", reference_signal)
    backing = wave(tmp_path, "backing", tone(hz=120))
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    assert np.max(plan.gains, initial=0) <= 9
    assert plan.report["limitedFraction"] > 0.9


def test_balance_preserves_silent_samples_and_calibrates_short_singing(tmp_path):
    signal = np.zeros(16000 * 3)
    signal[16000:19200] = tone(seconds=0.2, gain=0.03)
    vocal = wave(tmp_path, "vocal", signal)
    backing = wave(tmp_path, "backing", tone(seconds=3, hz=120))
    reference = wave(tmp_path, "ref", signal * 2)
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    assert plan.active.any()
    gains = np.interp(np.arange(len(signal)) / 16000, plan.times, plan.gains)
    np.testing.assert_array_equal((signal * 10 ** (gains / 20))[signal == 0], 0)
    assert np.max(plan.gains[plan.active]) > 1


def test_one_matching_syllable_cannot_calibrate_unmatched_whole_song(tmp_path):
    signal = tone(seconds=5)
    vocal = wave(tmp_path, "vocal", signal)
    backing = wave(tmp_path, "backing", tone(seconds=5, hz=120))
    expected = np.zeros_like(signal)
    expected[16000:19200] = signal[16000:19200] * 2
    reference = wave(tmp_path, "reference", expected)
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    assert not plan.report["referenceUsed"]
    np.testing.assert_array_equal(plan.gains, np.zeros_like(plan.gains))


def test_reference_balance_keeps_calibration_without_new_outro_targets(tmp_path):
    signal = tone(seconds=5)
    vocal = wave(tmp_path, "vocal", signal)
    backing = wave(tmp_path, "backing", tone(seconds=5, hz=120))
    expected = signal * 2
    expected[48000:] = 0
    reference = wave(tmp_path, "reference", expected)
    plan = plan_balance(vocal, backing, reference, backing, threading.Event())
    assert plan.report["referenceUsed"]
    assert np.median(plan.gains[plan.times < 2.5]) > 5
    np.testing.assert_allclose(plan.gains[plan.times > 3.5], 6.0206, atol=0.05)
    assert plan.report["inputCalibrationDb"] == pytest.approx(6.0206, abs=0.05)


def test_unmask_only_changes_overlapping_band_during_voice(tmp_path):
    vocal_signal = tone(seconds=4, hz=2300)
    vocal_signal[32000:] = 0
    voice = wave(tmp_path, "vocal", vocal_signal)
    signal = tone(seconds=4, hz=2300) + tone(seconds=4, hz=120)
    backing = wave(tmp_path, "backing", np.column_stack((signal, signal * 0.6)))
    # The helper tolerates a mono detector, while production format is checked at entry.
    output = tmp_path / "ducked.wav"
    report = duck_backing(voice, backing, output, threading.Event())
    mixed, _ = sf.read(output)
    original, _ = sf.read(backing)
    assert report["applied"]
    assert 0 < report["maxReductionDb"] <= 3.00001
    np.testing.assert_array_equal(mixed[48000:], original[48000:])
    np.testing.assert_allclose(mixed[:, 1], mixed[:, 0] * 0.6, atol=2e-8)
    time = np.arange(16000) / 16000
    for hz, minimum in ((120, 0.98), (2300, 0.70)):
        basis = np.exp(-2j * np.pi * hz * time)
        ratio = abs(np.dot(mixed[8000:24000, 0], basis)) / abs(
            np.dot(original[8000:24000, 0], basis)
        )
        assert minimum <= ratio <= (0.96 if hz == 2300 else 1.02)


def test_no_conflict_keeps_backing_samples_identical(tmp_path):
    voice = wave(tmp_path, "vocal", tone(hz=220))
    backing = wave(tmp_path, "backing", tone(hz=120))
    target = tmp_path / "duck.wav"
    report = duck_backing(voice, backing, target, threading.Event())
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(backing)[0], sf.read(target)[0])


def test_tempo_requires_repeated_evidence_and_rejects_steady_tone(tmp_path):
    steady = wave(tmp_path, "steady", tone(seconds=10, hz=120))
    bpm, confidence = estimate_tempo(steady, threading.Event())
    assert bpm is None and confidence < 0.5
    samples = np.zeros(16000 * 10)
    pulse = np.random.default_rng(2).normal(size=1600) * np.exp(-np.arange(1600) / 220) * 0.2
    for start in range(0, len(samples) - len(pulse), 8000):
        samples[start : start + len(pulse)] += pulse
    bpm, confidence = estimate_tempo(wave(tmp_path, "rhythm", samples), threading.Event())
    assert bpm == pytest.approx(120, abs=3) and confidence >= 0.5


def test_dry_reference_adds_no_mandatory_space(tmp_path):
    source = wave(tmp_path, "voice", tone())
    backing = wave(tmp_path, "backing", tone(hz=120))
    target = tmp_path / "spatial.wav"
    report = render_sends(source, backing, target, threading.Event(), reference=source)
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(source)[0], sf.read(target)[0])


def test_matching_breathy_releases_do_not_add_reverb_to_dry_capture(tmp_path):
    rate = 16000
    size = rate * 14
    noise = sosfilt(
        butter(2, [300, 5000], btype="bandpass", fs=rate, output="sos"),
        np.random.default_rng(7).normal(size=size),
    )
    signal = np.zeros(size)
    for start in (1, 3, 5, 7, 9, 11):
        left, right = start * rate, round((start + 0.6) * rate)
        signal[left:right] = noise[left:right] * 0.12
        release = round(0.8 * rate)
        signal[right : right + release] = (
            noise[right : right + release] * 0.12 * np.exp(-6.9 * np.arange(release) / rate / 0.6)
        )
    source = wave(tmp_path, "voice", signal)
    backing = wave(tmp_path, "backing", tone(seconds=14, hz=120))
    target = tmp_path / "spatial.wav"
    report = render_sends(
        source, backing, target, threading.Event(), reference=source, recorded_is_dry=True
    )
    assert report["referenceTailCount"] >= 3
    assert report["existingWetRatio"] > 0
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(source)[0], sf.read(target)[0])


def test_supported_diffuse_reverb_has_a_tail_after_dry_phrase_and_no_time_shift(tmp_path):
    rate = 16000
    size = rate * 14
    noise = sosfilt(
        butter(2, [300, 5000], btype="bandpass", fs=rate, output="sos"),
        np.random.default_rng(3).normal(size=size),
    )
    dry, reference = np.zeros(size), np.zeros(size)
    for start in (1, 3, 5, 7, 9, 11):
        left, right = start * rate, round((start + 0.6) * rate)
        dry[left:right] = noise[left:right] * 0.12
        duration = round(0.8 * rate)
        reference[right : right + duration] = (
            noise[right : right + duration] * 0.05 * np.exp(-6.9 * np.arange(duration) / rate / 1.6)
        )
    reference += dry
    voice = wave(tmp_path, "voice", dry)
    expected = wave(tmp_path, "reference", reference)
    backing = wave(tmp_path, "backing", tone(seconds=14, hz=120))
    target = tmp_path / "spatial.wav"
    report = render_sends(voice, backing, target, threading.Event(), reference=expected)
    output, _ = sf.read(target)
    original, _ = sf.read(voice)
    assert report["applied"] and report["referenceTailCount"] >= 3
    assert 1 < report["decaySeconds"] < 2
    assert output.shape == original.shape
    # Predelay must leave the original onset exactly in place; no extra dry copy.
    np.testing.assert_array_equal(output[rate : rate + 200], original[rate : rate + 200])
    assert np.sqrt(np.mean(output[round(1.65 * rate) : round(1.9 * rate)] ** 2)) > 0.002
    assert np.max(abs(output)) < 1.3 * np.max(abs(original))


def test_sustained_fading_note_is_not_a_reverb_measurement(tmp_path):
    rate = 16000
    dry = np.zeros(rate * 14)
    for start in (1, 3, 5, 7, 9, 11):
        time = np.arange(rate) / rate
        dry[start * rate : (start + 1) * rate] = (
            0.1 * np.sin(2 * np.pi * 220 * time) * np.exp(-6 * np.maximum(0, time - 0.3))
        )
    voice = wave(tmp_path, "voice", dry)
    backing = wave(tmp_path, "backing", tone(seconds=14, hz=120))
    target = tmp_path / "spatial.wav"
    report = render_sends(voice, backing, target, threading.Event(), reference=voice)
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(voice)[0], sf.read(target)[0])


@pytest.mark.parametrize("seconds,level", [(0.16, 0.2), (3.0, 0.1), (3.0, 1.4)])
def test_master_preserves_samples_and_limits_measured_true_peak(tmp_path, seconds, level):
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    source = wave(tmp_path, "mix", tone(seconds=seconds, hz=3700, gain=level))
    reference = wave(tmp_path, "reference", tone(seconds=seconds, hz=3700, gain=0.15))
    target = tmp_path / "master.wav"
    report = deliver_master(renderer, source, target, threading.Event(), reference=reference)
    assert sf.info(target).frames == sf.info(source).frames
    assert sf.info(target).samplerate == 16000
    assert report["truePeakDbtp"] <= -1
    assert report["verified"]
    json.dumps(report, allow_nan=False)


def test_master_target_follows_quiet_and_loud_reference(tmp_path):
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    source = wave(tmp_path, "source", tone(seconds=3, hz=3700, gain=0.1))
    results = []
    for gain in (0.06, 0.2):
        reference = wave(tmp_path, f"ref-{gain}", tone(seconds=3, hz=3700, gain=gain))
        results.append(
            deliver_master(
                renderer,
                source,
                tmp_path / f"out-{gain}.wav",
                threading.Event(),
                reference=reference,
            )
        )
    assert results[1]["targetLufs"] - results[0]["targetLufs"] > 7
    assert results[1]["integratedLufs"] - results[0]["integratedLufs"] > 7
    assert all(result["plannedLimiterReductionDb"] <= 2.00001 for result in results)


def test_silent_vocal_preserves_music_without_nan_or_gain_boost(tmp_path):
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    vocal = wave(tmp_path, "vocal", np.zeros(32000))
    backing = wave(tmp_path, "backing", tone(seconds=2, hz=120))
    report = mix_and_master(
        renderer,
        vocal,
        backing,
        tmp_path / "master.wav",
        threading.Event(),
        reference_vocal=vocal,
        reference_backing=backing,
    )
    assert report["balance"]["activeSeconds"] == 0
    assert report["balance"]["medianGainDb"] == 0
    assert not report["backingEq"]["applied"]
    json.dumps(report, allow_nan=False)


def test_invalid_samples_do_not_replace_existing_master(tmp_path):
    source = tone(seconds=2)
    source[100] = float("nan")
    vocal = wave(tmp_path, "vocal", source)
    backing = wave(tmp_path, "backing", tone(seconds=2, hz=120))
    target = tmp_path / "master.wav"
    target.write_bytes(b"previous good master")
    with pytest.raises(DomainError):
        mix_and_master(
            FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, target, threading.Event()
        )
    assert target.read_bytes() == b"previous good master"


def test_cancelled_mix_does_not_replace_published_output(tmp_path):
    source = wave(tmp_path, "vocal", tone())
    backing = wave(tmp_path, "backing", tone(hz=120))
    target = tmp_path / "master.wav"
    target.write_bytes(b"existing master")
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(DomainError):
        mix_and_master(
            FfmpegStudioMasterRenderer(ProcessRunner()), source, backing, target, cancelled
        )
    assert target.read_bytes() == b"existing master"


def test_end_to_end_reference_master_is_finite_and_input_immutable(tmp_path):
    renderer = FfmpegStudioMasterRenderer(ProcessRunner())
    vocal = wave(tmp_path, "vocal", tone(seconds=2))
    backing = wave(tmp_path, "backing", tone(seconds=2, hz=120))
    reference = wave(tmp_path, "ref", tone(seconds=2, gain=0.05))
    originals = [p.read_bytes() for p in (vocal, backing, reference)]
    target = tmp_path / "master.wav"
    report = mix_and_master(
        renderer,
        vocal,
        backing,
        target,
        threading.Event(),
        reference_vocal=reference,
        reference_backing=backing,
    )
    assert sf.info(target).frames == 32000
    assert report["delivery"]["verified"]
    assert report["balance"]["medianGainDb"] == pytest.approx(-6.02, abs=0.3)
    assert originals == [p.read_bytes() for p in (vocal, backing, reference)]
    json.dumps(report, allow_nan=False)
