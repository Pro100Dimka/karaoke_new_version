from pathlib import Path
import threading
import numpy as np
import pytest
import soundfile as sf
from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_audio import _write_gain_envelope
from backend.recordings.studio_calibration import build_gain_plan, validate_gain_plan


def render_plan(root: Path, voice: np.ndarray, music: np.ndarray, *, overlap: float = 0.5):
    vocal, backing, output = (root / name for name in ["voice.wav", "backing.wav", "out.wav"])
    sf.write(vocal, voice, 8000, subtype="FLOAT")
    sf.write(backing, music, 8000, subtype="FLOAT")
    before = [path.read_bytes() for path in (vocal, backing)]
    cancel = threading.Event()
    plan = build_gain_plan(
        FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, overlap, cancel
    )
    _write_gain_envelope(vocal, output, plan.times, plan.gains, cancel)
    assert [path.read_bytes() for path in (vocal, backing)] == before
    actual, rate = sf.read(output, always_2d=voice.ndim == 2)
    assert rate == 8000 and actual.shape == voice.shape
    return actual, plan, validate_gain_plan(output, plan, cancel)


def tone(seconds=8, frequency=700):
    time = np.arange(8000 * seconds) / 8000
    return time, 0.05 * np.sin(2 * np.pi * frequency * time)


def rms_db(samples):
    return 10 * np.log10(max(float(np.mean(samples**2)), 1e-12))


def test_single_plan_keeps_steady_singing_steady(tmp_path):
    _, voice = tone()
    actual, plan, qc = render_plan(tmp_path, voice, voice)
    levels = [rms_db(actual[i * 8000 : (i + 1) * 8000]) for i in range(1, 7)]
    assert np.ptp(levels) < 0.2
    assert qc["p90ErrorDb"] < 1
    assert plan.report["method"] == "single-context-envelope"


@pytest.mark.parametrize("scale", [0.1, 1.0, 3.0])
def test_single_plan_is_independent_of_input_gain(tmp_path, scale):
    _, voice = tone()
    actual, _, _ = render_plan(tmp_path, voice * scale, voice)
    assert rms_db(actual[8000:-8000]) - rms_db(voice[8000:-8000]) == pytest.approx(-4.5, abs=0.2)


def test_short_loud_and_quiet_words_are_leveled_by_one_controller(tmp_path):
    time, voice = tone()
    voice[(time >= 4) & (time < 4.2)] *= 4
    voice[(time >= 5) & (time < 5.2)] *= 0.25
    _, music = tone()
    actual, _, qc = render_plan(tmp_path, voice, music)
    baseline = rms_db(actual[2 * 8000 : 3 * 8000])
    assert rms_db(actual[round(4.02 * 8000) : round(4.18 * 8000)]) - baseline < 4
    assert rms_db(actual[round(5.02 * 8000) : round(5.18 * 8000)]) - baseline > -4
    assert qc["p90ErrorDb"] < 3


def test_low_frequency_tail_is_not_boosted_as_singing(tmp_path):
    time, voice = tone()
    voice[time >= 4] = 0.003 * np.sin(2 * np.pi * 80 * time[time >= 4])
    _, music = tone()
    actual, plan, _ = render_plan(tmp_path, voice, music)
    assert rms_db(actual[5 * 8000 : 7 * 8000]) <= rms_db(voice[5 * 8000 : 7 * 8000]) + 0.1
    assert not plan.active[plan.times > 5].any()


def test_phrase_boundaries_do_not_amplify_quiet_gap_noise(tmp_path):
    time, voice = tone()
    music = voice.copy()
    gap = (time >= 3) & (time < 5)
    voice[gap] *= 0.0002
    actual, plan, _ = render_plan(tmp_path, voice, music)
    boundary = (time >= 3.04) & (time < 3.1)
    assert rms_db(actual[boundary]) - rms_db(voice[boundary]) < 3
    assert not plan.active[(plan.times >= 3.2) & (plan.times < 4.8)].any()


@pytest.mark.parametrize("duration", [0.16, 1.2])
def test_unvoiced_breath_keeps_its_level_relative_to_neighboring_singing(tmp_path, duration):
    from scipy.signal import butter, sosfilt

    time, voice = tone()
    music = voice.copy()
    noise = sosfilt(
        butter(2, [500, 3400], fs=8000, btype="bandpass", output="sos"),
        np.random.default_rng(31).normal(size=len(voice)),
    )
    breath = (time >= 3) & (time < 3 + duration)
    voice[breath] = noise[breath] * 0.004
    actual, plan, _ = render_plan(tmp_path, voice, music)
    middle = (time >= 3.05) & (time < 3 + duration - 0.03)
    before_ratio = rms_db(voice[middle]) - rms_db(voice[8000:16000])
    after_ratio = rms_db(actual[middle]) - rms_db(actual[8000:16000])
    assert after_ratio <= before_ratio + 2
    assert rms_db(actual[middle]) >= rms_db(voice[middle]) - 8
    assert plan.report["unvoicedProtection"]["protectedSeconds"] > 0


def test_breath_protection_preserves_a_quiet_harmonic_word(tmp_path):
    time, music = tone()
    voice = sum(0.025 / harmonic * np.sin(2 * np.pi * 140 * harmonic * time)
                for harmonic in range(1, 9))
    voice[(time >= 4) & (time < 4.4)] *= 0.2
    actual, _, _ = render_plan(tmp_path, voice, music)
    assert rms_db(actual[round(4.1 * 8000):round(4.3 * 8000)]) > rms_db(actual[8000:16000]) - 4


def test_breath_protection_does_not_guess_a_gain_without_voiced_neighbors(tmp_path):
    from backend.recordings.studio_calibration import _protect_unvoiced

    voice = tmp_path / "noise.wav"
    sf.write(voice, np.random.default_rng(91).normal(0, 0.01, 8000 * 3), 8000)
    times = np.arange(0.01, 3, 0.02)
    desired = np.sin(times) * 5
    actual, report = _protect_unvoiced(voice, times, desired, np.ones(len(times), bool), threading.Event())
    np.testing.assert_array_equal(actual, desired)
    assert report["protectedSeconds"] == 0


def test_plan_follows_a_musical_crescendo(tmp_path):
    time, voice = tone(12)
    music = voice * np.interp(time, [0, 4, 8, 12], [0.1, 0.1, 1, 1])
    actual, _, qc = render_plan(tmp_path, voice, music)
    assert rms_db(actual[9 * 8000 : 11 * 8000]) - rms_db(actual[8000 : 3 * 8000]) > 12
    assert qc["p90ErrorDb"] < 3


def test_music_pause_does_not_mute_the_voice(tmp_path):
    time, voice = tone()
    music = voice.copy()
    music[(time > 3) & (time < 5)] = 0
    actual, _, _ = render_plan(tmp_path, voice, music)
    assert (
        abs(rms_db(actual[round(3.8 * 8000) : round(4.2 * 8000)]) - rms_db(actual[8000 : 2 * 8000]))
        < 3
    )


def test_silence_is_preserved(tmp_path):
    _, music = tone()
    actual, plan, _ = render_plan(tmp_path, np.zeros_like(music), music)
    np.testing.assert_array_equal(actual, 0)
    assert not plan.active.any()


def test_overlap_changes_placement_without_song_specific_parameters(tmp_path):
    _, voice = tone()
    first, _, _ = render_plan(tmp_path, voice, voice, overlap=0)
    second, _, _ = render_plan(tmp_path, voice, voice, overlap=1)
    assert rms_db(second[8000:-8000]) - rms_db(first[8000:-8000]) == pytest.approx(3, abs=0.1)


def test_balance_keeps_vocal_harmonics_audible_above_a_shared_bass_body(tmp_path):
    time, music = tone(frequency=900)
    voice = 0.05 * np.sin(2 * np.pi * 150 * time) + 0.035 * np.sin(2 * np.pi * 900 * time)
    actual, plan, _ = render_plan(tmp_path, voice, music)
    section = actual[8000:-8000]
    axis = np.arange(len(section)) / 8000
    amplitude = 2 * abs(np.mean(section * np.exp(-2j * np.pi * 900 * axis)))
    assert 20 * np.log10(amplitude / 0.05) == pytest.approx(-4.5, abs=0.5)
    assert plan.report["presenceCompensationDb"] > 0


def test_center_presence_does_not_raise_voice_over_side_only_music(tmp_path):
    time, music = tone(frequency=900)
    voice = 0.07 * np.sin(2 * np.pi * 150 * time) + 0.035 * np.sin(2 * np.pi * 900 * time)
    _, plan, _ = render_plan(
        tmp_path, np.column_stack((voice, voice)), np.column_stack((music, -music))
    )
    assert plan.report["presenceCompensationDb"] == 0


def test_presence_does_not_make_a_bass_heavy_voice_louder_than_the_whole_backing(tmp_path):
    from backend.recordings.studio_delivery import measure_mix_loudness

    time, music = tone(frequency=900)
    voice = 0.07 * np.sin(2 * np.pi * 150 * time) + 0.035 * np.sin(2 * np.pi * 900 * time)
    _, plan, _ = render_plan(tmp_path, voice, music)
    vocal, backing = measure_mix_loudness(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        tmp_path / "out.wav",
        tmp_path / "backing.wav",
        threading.Event(),
    )
    assert plan.report["presenceCompensationDb"] == pytest.approx(4.5)
    assert np.median(vocal[10:-10] - backing[10:-10]) <= 0.1


def test_antiphase_stereo_is_not_canceled(tmp_path):
    _, mono = tone()
    voice = np.column_stack((mono, -mono))
    actual, _, _ = render_plan(tmp_path, voice, voice)
    assert rms_db(actual[8000:-8000]) > -60
    np.testing.assert_allclose(actual[:, 0] + actual[:, 1], 0, atol=1e-7)


def test_spectral_plan_does_not_compare_a_band_to_missing_high_frequencies(tmp_path):
    from backend.recordings.studio_spectrum import measure_mix_spectrum

    _, voice = tone(frequency=3000)
    music = np.random.default_rng(21).normal(0, 0.05, len(voice))
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, voice, 8000, subtype="FLOAT")
    sf.write(backing, music, 8000, subtype="FLOAT")
    plan = measure_mix_spectrum(vocal, backing, threading.Event())
    assert not any(band["frequencyHz"] > 2400 for band in plan["bands"])
