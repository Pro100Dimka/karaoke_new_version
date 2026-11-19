"""Audio-domain contracts of the adaptive vocal insert path."""

from pathlib import Path
import json
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer


def _renderer():
    return FfmpegStudioMasterRenderer(ProcessRunner())


def _write(path: Path, data: np.ndarray, rate: int = 48000) -> Path:
    sf.write(path, data, rate, subtype="FLOAT")
    return path


def _rms(values: np.ndarray) -> float:
    return float(np.sqrt(np.mean(values**2)))


def _db_ratio(first: np.ndarray, second: np.ndarray) -> float:
    return float(20 * np.log10(max(_rms(first), 1e-12) / max(_rms(second), 1e-12)))


def test_short_sparse_vocal_is_kept_without_minimum_duration_gate(tmp_path):
    from backend.recordings.studio_adaptive_voice import prepare_voice, process_voice

    rate = 16000
    time = np.arange(rate * 8) / rate
    voice = 0.08 * np.sin(2 * np.pi * 210 * time) * ((time >= 4) & (time < 4.18))
    source = _write(tmp_path / "short.wav", voice, rate)
    prepared, target = tmp_path / "prepared.wav", tmp_path / "result.wav"
    preparation = prepare_voice(_renderer(), source, prepared, threading.Event())
    report = process_voice(_renderer(), prepared, target, threading.Event())
    output, actual_rate = sf.read(target)
    assert actual_rate == rate and output.shape == voice.shape
    assert _rms(output[rate * 4 : round(rate * 4.18)]) > 0.7 * _rms(
        voice[rate * 4 : round(rate * 4.18)]
    )
    assert abs(np.argmax(abs(output)) - np.argmax(abs(voice))) < rate * 0.18
    json.dumps([preparation, report], allow_nan=False)


@pytest.mark.parametrize("frequency", [40, 55, 65, 100])
def test_low_male_fundamental_is_not_cut_by_fixed_100_hz_filter(tmp_path, frequency):
    from backend.recordings.studio_adaptive_voice import process_voice

    rate = 16000
    time = np.arange(rate * 3) / rate
    voice = 0.15 * np.sin(2 * np.pi * frequency * time)
    source = _write(tmp_path / "bass.wav", voice, rate)
    target = tmp_path / "result.wav"
    report = process_voice(_renderer(), source, target, threading.Event())
    output, _ = sf.read(target)
    assert _db_ratio(output[rate:], voice[rate:]) > -1.3
    assert report["subtractiveEq"]["highpassHz"] < frequency * 0.65
    assert not report["subtractiveEq"]["resonances"]


def test_local_clip_gain_reduces_word_outliers_and_keeps_phrase_dynamics(tmp_path):
    from backend.recordings.studio_adaptive_voice import prepare_voice

    rate = 16000
    time = np.arange(rate * 6) / rate
    envelope = np.where(time < 3, 0.08, 0.16)
    envelope[(time >= 1) & (time < 1.35)] *= 0.1
    envelope[(time >= 2) & (time < 2.3)] *= 3
    voice = envelope * np.sin(2 * np.pi * 250 * time)
    source = _write(tmp_path / "words.wav", voice, rate)
    target = tmp_path / "result.wav"
    report = prepare_voice(_renderer(), source, target, threading.Event())
    output, _ = sf.read(target)
    quiet = slice(round(1.08 * rate), round(1.27 * rate))
    loud = slice(round(2.08 * rate), round(2.22 * rate))
    assert _db_ratio(output[quiet], voice[quiet]) > 1.5
    assert _db_ratio(output[loud], voice[loud]) < -1.0
    # Long musical rise remains, independently of the syllable corrections.
    assert _db_ratio(output[4 * rate : 5 * rate], output[rate // 4 : 3 * rate // 4]) > 4
    assert report["clipGain"]["maxBoostDb"] <= 6
    assert report["clipGain"]["maxCutDb"] <= 6


def test_cleanup_preserves_quiet_breathy_ending_and_attenuates_only_established_gap(tmp_path):
    from backend.recordings.studio_adaptive_voice import prepare_voice

    rate = 16000
    time = np.arange(rate * 8) / rate
    random = np.random.default_rng(781)
    room = random.standard_normal(len(time)) * 0.0004
    voice = 0.1 * np.sin(2 * np.pi * 220 * time) * ((time >= 1) & (time < 2))
    ending = (time >= 2) & (time < 2.9)
    voice += random.standard_normal(len(time)) * 0.006 * np.exp(-np.maximum(0, time - 2)) * ending
    source = _write(tmp_path / "quiet-ending.wav", voice + room, rate)
    target = tmp_path / "result.wav"
    report = prepare_voice(_renderer(), source, target, threading.Event())
    output, _ = sf.read(target)
    end = slice(round(2.6 * rate), round(2.8 * rate))
    gap = slice(5 * rate, 6 * rate)
    assert _db_ratio(output[end], (voice + room)[end]) > -0.6
    assert _db_ratio(output[gap], room[gap]) < -2
    assert report["cleanup"]["maxReductionDb"] <= 6
    assert output.shape == voice.shape


def test_quiet_held_vowel_cannot_be_used_as_the_room_noise_floor(tmp_path):
    from backend.recordings.studio_adaptive_voice import prepare_voice

    rate = 16000
    time = np.arange(rate * 8) / rate
    voice = np.where(time < 4, 0.3, 0.003) * np.sin(2 * np.pi * 220 * time)
    source = _write(tmp_path / "quiet-held-vowel.wav", voice, rate)
    target = tmp_path / "prepared.wav"
    prepare_voice(_renderer(), source, target, threading.Event())
    output, _ = sf.read(target)
    assert _db_ratio(output[6 * rate :], voice[6 * rate :]) > -1


def test_split_band_deessing_reduces_sibilants_without_ducking_body(tmp_path):
    from backend.recordings.studio_adaptive_dynamics import deess_voice

    rate = 48000
    time = np.arange(rate * 4 + 37) / rate
    voice = 0.08 * np.sin(2 * np.pi * 900 * time)
    voice += 0.16 * np.sin(2 * np.pi * 7000 * time) * ((time >= 1.2) & (time < 1.7))
    source = _write(tmp_path / "sibilance.wav", voice, rate)
    target = tmp_path / "result.wav"
    report = deess_voice(source, target, threading.Event())
    output, _ = sf.read(target)
    section = slice(round(1.3 * rate), round(1.6 * rate))
    body = butter(4, [700, 1100], btype="bandpass", fs=rate, output="sos")
    high = butter(4, [6500, 7500], btype="bandpass", fs=rate, output="sos")
    assert _db_ratio(sosfilt(high, output)[section], sosfilt(high, voice)[section]) < -3
    assert abs(_db_ratio(sosfilt(body, output)[section], sosfilt(body, voice)[section])) < 0.15
    assert output.shape == voice.shape
    assert report["maxReductionDb"] <= 6


def test_clean_bright_vowel_is_not_deessed_for_having_high_harmonics(tmp_path):
    from backend.recordings.studio_adaptive_dynamics import deess_voice

    rate = 48000
    time = np.arange(rate * 2) / rate
    voice = 0.08 * np.sin(2 * np.pi * 900 * time) + 0.08 * np.sin(2 * np.pi * 7000 * time)
    source = _write(tmp_path / "bright.wav", voice, rate)
    target = tmp_path / "result.wav"
    report = deess_voice(source, target, threading.Event())
    output, _ = sf.read(target)
    assert _db_ratio(output, voice) > -0.2
    assert report["maxReductionDb"] < 0.5


@pytest.mark.parametrize("aperiodic", [False, True])
def test_quiet_unvoiced_phrase_is_not_mistaken_for_a_loud_sibilant(tmp_path, aperiodic):
    from backend.recordings.studio_adaptive_dynamics import deess_voice

    rate = 48000
    time = np.arange(rate * 5) / rate
    voice = 0.1 * np.sin(2 * np.pi * 900 * time) * (time < 2)
    breath = (
        sosfilt(
            butter(3, [5500, 9500], btype="bandpass", fs=rate, output="sos"),
            np.random.default_rng(811).standard_normal(len(time)),
        )
        if aperiodic
        else np.sin(2 * np.pi * 7000 * time)
    )
    voice += 0.006 * breath * ((time > 3) & (time < 3.6))
    source = _write(tmp_path / "quiet-unvoiced.wav", voice, rate)
    target = tmp_path / "result.wav"
    deess_voice(source, target, threading.Event())
    output, _ = sf.read(target)
    section = slice(round(rate * 3.15), round(rate * 3.45))
    assert _db_ratio(output[section], voice[section]) > -0.3


def test_sustained_bright_phrase_remains_bright_after_a_darker_phrase(tmp_path):
    from backend.recordings.studio_adaptive_dynamics import deess_voice

    rate = 48000
    time = np.arange(rate * 6) / rate
    voice = 0.08 * np.sin(2 * np.pi * 900 * time)
    voice += 0.08 * np.sin(2 * np.pi * 7000 * time) * (time >= 3)
    source = _write(tmp_path / "changed-tone.wav", voice, rate)
    target = tmp_path / "result.wav"
    deess_voice(source, target, threading.Event())
    output, _ = sf.read(target)
    high = butter(4, [6500, 7500], fs=rate, btype="bandpass", output="sos")
    section = slice(4 * rate, 5 * rate)
    assert _db_ratio(sosfilt(high, output)[section], sosfilt(high, voice)[section]) > -0.3


def test_harmonics_of_low_voice_are_not_treated_as_room_resonances(tmp_path):
    from backend.recordings.studio_adaptive_features import analyze_voice
    from backend.recordings.studio_adaptive_voice import _subtractive_plan

    rate = 16000
    time = np.arange(rate * 4) / rate
    reference = sum(
        0.04 / harmonic * np.sin(2 * np.pi * 65 * harmonic * time) for harmonic in range(1, 24)
    )
    voice = reference + 0.12 * np.sin(2 * np.pi * 130 * time)
    source = _write(tmp_path / "harmonics.wav", voice, rate)
    reference_path = _write(tmp_path / "reference.wav", reference, rate)
    cancel = threading.Event()
    _, report = _subtractive_plan(
        analyze_voice(source, cancel), analyze_voice(reference_path, cancel)
    )
    assert not report["resonances"]


@pytest.mark.parametrize("rate", [8000, 16000, 48000])
def test_reference_ratios_cannot_cut_a_near_empty_spectral_band(tmp_path, rate):
    from backend.recordings.studio_adaptive_features import analyze_voice
    from backend.recordings.studio_adaptive_voice import _subtractive_plan

    time = np.arange(rate * 4) / rate
    upper = 0.035 * np.sin(2 * np.pi * 900 * time) + 0.02 * np.sin(2 * np.pi * 1800 * time)
    source = _write(tmp_path / "voice.wav", upper + 0.12 * np.sin(2 * np.pi * 150 * time), rate)
    reference = _write(
        tmp_path / "reference.wav", upper + 0.015 * np.sin(2 * np.pi * 150 * time), rate
    )
    cancel = threading.Event()
    _, report = _subtractive_plan(analyze_voice(source, cancel), analyze_voice(reference, cancel))
    assert not report["resonances"]


def test_supported_broad_coloration_still_gets_a_measured_cut(tmp_path):
    from backend.recordings.studio_adaptive_features import analyze_voice
    from backend.recordings.studio_adaptive_voice import _subtractive_plan

    rate = 16000
    noise = np.random.default_rng(891).standard_normal(rate * 4)
    reference = _write(
        tmp_path / "reference.wav",
        sosfilt(butter(2, 3500, fs=rate, output="sos"), noise) * 0.04,
        rate,
    )
    source = tmp_path / "colored.wav"
    cancel = threading.Event()
    _renderer()._mix(
        reference,
        reference,
        "[0:a]equalizer=f=500:t=q:w=1:g=9[out]",
        ["-c:a", "pcm_f32le", str(source)],
        cancel,
    )
    _, report = _subtractive_plan(analyze_voice(source, cancel), analyze_voice(reference, cancel))
    assert any(
        350 < band["frequencyHz"] < 700 and band["gainDb"] < -1 for band in report["resonances"]
    )


def test_full_chain_retains_an_aperiodic_phrase_at_six_percent_level(tmp_path):
    from backend.recordings.studio_adaptive_voice import prepare_voice, process_voice

    rate = 16000
    time = np.arange(rate * 8) / rate
    noise = np.random.default_rng(819).standard_normal(len(time))
    texture = sosfilt(butter(3, [150, 3500], btype="bandpass", fs=rate, output="sos"), noise)
    voice = texture * (0.12 * ((time > 1) & (time < 3)) + 0.12 * 0.06 * ((time > 5) & (time < 6.1)))
    source = _write(tmp_path / "aperiodic-phrase.wav", voice, rate)
    prepared, target = tmp_path / "prepared.wav", tmp_path / "result.wav"
    prepare_voice(_renderer(), source, prepared, threading.Event())
    process_voice(_renderer(), prepared, target, threading.Event())
    output, _ = sf.read(target)
    section = slice(round(rate * 5.3), round(rate * 5.8))
    assert _db_ratio(output[section], voice[section]) > -1
    assert output.shape == voice.shape


def test_insert_order_reduces_excess_dynamics_and_links_stereo(tmp_path):
    from backend.recordings.studio_adaptive_voice import process_voice

    rate = 16000
    time = np.arange(rate * 6 + 11) / rate
    amplitude = np.where((time % 1) < 0.4, 0.24, 0.04)
    left = amplitude * np.sin(2 * np.pi * 250 * time)
    voice = np.column_stack([left, left * 0.5])
    source = _write(tmp_path / "dynamics.wav", voice, rate)
    target = tmp_path / "result.wav"
    report = process_voice(_renderer(), source, target, threading.Event())
    output, _ = sf.read(target)
    loud, soft = (
        slice(round(rate * 2.15), round(rate * 2.3)),
        slice(round(rate * 2.8), round(rate * 2.95)),
    )
    assert (
        _db_ratio(output[loud, 0], output[soft, 0]) < _db_ratio(voice[loud, 0], voice[soft, 0]) - 2
    )
    assert abs(_db_ratio(output[:, 0], output[:, 1]) - 6.0206) < 0.3
    assert output.shape == voice.shape
    assert report["order"] == [
        "subtractive-eq",
        "peak-compressor",
        "leveling-compressor",
        "deesser",
        "color-eq",
        "saturation",
    ]
    assert np.isfinite(output).all()
    assert report["peakCompressor"]["applied"]
    assert report["levelingCompressor"]["applied"]
    assert report["levelingCompressor"]["before"] == report["peakCompressor"]["after"]
    json.dumps(report, allow_nan=False)


def test_saturation_preserves_impulse_timing_and_steady_energy(tmp_path):
    from backend.recordings.studio_adaptive_dynamics import saturate_voice
    from backend.recordings.studio_adaptive_features import analyze_voice

    rate = 48000
    time = np.arange(rate * 3 + 9) / rate
    voice = 0.1 * np.sin(2 * np.pi * 250 * time)
    voice[65536] += 0.5
    source = _write(tmp_path / "saturation.wav", voice, rate)
    target = tmp_path / "result.wav"
    cancel = threading.Event()
    report = saturate_voice(source, target, tmp_path, cancel, analyze_voice(source, cancel))
    output, _ = sf.read(target)
    assert np.argmax(abs(output)) == np.argmax(abs(voice))
    assert output.shape == voice.shape
    assert abs(_db_ratio(output, voice)) < 0.01
    assert report["oversampling"] == 4
    # No artificial step where the streaming block ends.
    assert abs(output[65535] - voice[65535]) < 0.002


def test_saturation_oversampling_rejects_folded_high_harmonics(tmp_path):
    from backend.recordings.studio_adaptive_dynamics import saturate_voice
    from backend.recordings.studio_adaptive_features import analyze_voice

    rate = 48000
    time = np.arange(rate * 3) / rate
    source = _write(tmp_path / "high-note.wav", 0.8 * np.sin(2 * np.pi * 10000 * time), rate)
    target = tmp_path / "result.wav"
    cancel = threading.Event()
    saturate_voice(source, target, tmp_path, cancel, analyze_voice(source, cancel))
    output, _ = sf.read(target)
    spectrum = abs(np.fft.rfft(output[rate : 2 * rate] * np.hanning(rate)))
    alias_db = 20 * np.log10(max(spectrum[18000], 1e-12) / spectrum[10000])
    assert alias_db < -75


def test_subtractive_eq_does_not_change_when_reference_gain_changes(tmp_path):
    from backend.recordings.studio_adaptive_features import analyze_voice
    from backend.recordings.studio_adaptive_voice import _subtractive_plan

    rate = 16000
    random = np.random.default_rng(781)
    reference = (
        sosfilt(butter(2, 3500, fs=rate, output="sos"), random.standard_normal(rate * 4)) * 0.03
    )
    source = _write(tmp_path / "source.wav", reference, rate)
    cancel = threading.Event()
    measured = analyze_voice(source, cancel)
    reports = []
    for index, gain in enumerate((0.25, 1, 3)):
        path = _write(tmp_path / f"reference-{index}.wav", reference * gain, rate)
        reports.append(_subtractive_plan(measured, analyze_voice(path, cancel))[1])
    assert reports[0] == reports[1] == reports[2]


@pytest.mark.parametrize("method", ["prepare_voice", "process_voice"])
def test_nonfinite_samples_are_rejected_without_publishing(tmp_path, method):
    from backend.recordings import studio_adaptive_voice

    voice = np.zeros(8000)
    voice[500] = np.nan
    source = _write(tmp_path / "invalid.wav", voice, 8000)
    target = tmp_path / "result.wav"
    with pytest.raises(DependencyError, match="invalid|finite"):
        getattr(studio_adaptive_voice, method)(_renderer(), source, target, threading.Event())
    assert not target.exists()


def test_cancelled_preparation_does_not_write_a_candidate(tmp_path):
    from backend.recordings.studio_adaptive_voice import prepare_voice

    source = _write(tmp_path / "voice.wav", np.ones(8000) * 0.01, 8000)
    target = tmp_path / "result.wav"
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        prepare_voice(_renderer(), source, target, cancel)
    assert not target.exists()
