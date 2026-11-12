from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
import numpy as np
import threading
import soundfile as sf
import pytest
from backend.recordings.studio_dynamics import _protect_vocal_presence


def test_climax_ride_is_bounded_and_greater_than_intro():
    n = 500
    music = np.r_[np.full(200, -38.0), np.linspace(-38, -19, 150), np.full(150, -19.0)]
    voice = np.full(n, -27.0)
    gains = np.zeros(n)
    result, report = _protect_vocal_presence(gains, voice, music)
    assert 0 <= report["presenceBoostMaxDb"] <= 9
    assert np.median(result[350:480]) > np.median(result[20:150]) + 2
    assert np.all(result >= gains)


def test_silence_not_boosted():
    music = np.r_[np.full(200, -38.0), np.full(300, -19.0)]
    voice = np.r_[np.full(200, -27.0), np.full(300, -90.0)]
    result, _ = _protect_vocal_presence(np.zeros(500), voice, music)
    assert np.max(result[240:]) == 0


def test_invalid_profiles_are_safe():
    gains = np.zeros(20)
    result, _ = _protect_vocal_presence(gains, np.full(20, np.nan), np.zeros(20))
    np.testing.assert_array_equal(result, gains)


def test_steady_attenuated_voice_is_unchanged():
    voice = np.full(120, -12.0)
    music = np.full(120, -16.0)
    gains = np.full(120, -30.0)
    result, report = _protect_vocal_presence(gains, voice, music)
    np.testing.assert_array_equal(result, gains)
    assert report["presenceBoostMaxDb"] == 0


def test_steady_music_does_not_undo_the_song_balance_attenuation():
    voice = np.full(500, -24.0)
    music = np.full(500, -25.0)
    gains = np.full(500, -7.0)
    result, report = _protect_vocal_presence(gains, voice, music)
    np.testing.assert_array_equal(result, gains)
    assert report["presenceBoostMaxDb"] == 0


def test_already_rising_voice_is_not_boosted_again_with_the_accompaniment():
    music = np.r_[np.full(200, -38.0), np.linspace(-38, -19, 150), np.full(150, -19.0)]
    voice = music + 3.0
    gains = np.full(len(music), -4.0)
    result, _ = _protect_vocal_presence(gains, voice, music)
    np.testing.assert_allclose(result, gains, atol=0.1)


def test_finished_vocal_presence_preserves_intro_and_backing(tmp_path):
    from backend.recordings.studio_voice import control_vocal_presence

    rate = 8000
    time = np.arange(rate * 9) / rate
    voice = (0.05 * np.sin(2 * np.pi * 300 * time)).astype(np.float32)
    music_gain = np.interp(time, [0, 3, 6, 9], [0.1, 0.1, 1, 1])
    music = (0.05 * music_gain * np.sin(2 * np.pi * 1000 * time)).astype(np.float32)
    source, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(backing, music, rate, subtype="FLOAT")
    original_backing = backing.read_bytes()
    report = control_vocal_presence(source, backing, threading.Event())
    rendered, actual_rate = sf.read(source, dtype="float32")
    assert actual_rate == rate and rendered.shape == voice.shape
    np.testing.assert_array_equal(rendered[:rate], voice[:rate])
    assert np.sqrt(
        np.mean(rendered[7 * rate : 8 * rate] ** 2) / np.mean(voice[7 * rate : 8 * rate] ** 2)
    ) > 10 ** (2 / 20)
    assert 0 < report["presenceBoostMaxDb"] <= 9 + 1e-10
    assert backing.read_bytes() == original_backing


def test_vowel_spectrum_does_not_change_the_whole_voice_level(tmp_path):
    from backend.recordings.studio_voice import control_vocal_presence

    rate = 8000
    time = np.arange(rate * 12) / rate
    upper_share = np.where((time >= 6.5) & (time < 8.5), 0.05, 0.9)
    voice = 0.05 * (
        np.sqrt(1 - upper_share**2) * np.sin(2 * np.pi * 150 * time)
        + upper_share * np.sin(2 * np.pi * 1000 * time)
    )
    music_gain = np.interp(time, [0, 3, 6, 12], [0.1, 0.1, 1, 1])
    music = 0.05 * music_gain * np.sin(2 * np.pi * 1000 * time)
    source, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    sf.write(backing, music, rate, subtype="FLOAT")
    control_vocal_presence(source, backing, threading.Event())
    rendered, _ = sf.read(source)
    levels = [
        10 * np.log10(np.mean(rendered[round(a * rate) : round(b * rate)] ** 2))
        for a, b in [(7.2, 7.8), (9.2, 9.8), (1, 2)]
    ]
    assert abs(levels[0] - levels[1]) < 0.5
    assert min(levels[:2]) > levels[2] + 2


@pytest.mark.parametrize("frequency", [150, 500])
def test_backing_calibration_is_invariant_to_input_vocal_gain(tmp_path, frequency):
    from backend.recordings.studio_calibration import calibrate_mix

    time = np.arange(8000 * 4) / 8000
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(backing, 0.05 * np.sin(2 * np.pi * 700 * time), 8000, subtype="FLOAT")
    outputs = []
    for shift in [0, 8]:
        samples = 0.05 * 10 ** (shift / 20) * np.sin(2 * np.pi * frequency * time)
        sf.write(vocal, samples, 8000, subtype="FLOAT")
        outputs.append(
            shift
            + calibrate_mix(
                FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event(), {}
            )
        )
    assert abs(outputs[0] - outputs[1]) < 0.01
    assert max(outputs) <= 4.5


@pytest.mark.parametrize("silent_stem", ["voice", "backing"])
def test_backing_calibration_skips_silent_stems(tmp_path, silent_stem):
    from backend.recordings.studio_calibration import calibrate_mix

    time = np.arange(8000 * 4) / 8000
    for name in ["voice", "backing"]:
        samples = (
            np.zeros_like(time) if name == silent_stem else 0.05 * np.sin(2 * np.pi * 700 * time)
        )
        sf.write(tmp_path / f"{name}.wav", samples, 8000, subtype="FLOAT")
    assert (
        calibrate_mix(
            FfmpegStudioMasterRenderer(ProcessRunner()),
            tmp_path / "voice.wav",
            tmp_path / "backing.wav",
            threading.Event(),
            {},
        )
        == 0
    )


def test_backing_calibration_does_not_jump_at_zero_band_prominence(tmp_path):
    from backend.recordings.studio_calibration import calibrate_mix

    time = np.arange(8000 * 4) / 8000
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(backing, 0.05 * np.sin(2 * np.pi * 700 * time), 8000, subtype="FLOAT")
    outputs = []
    for shift in [-0.01, 0.01]:
        sf.write(
            vocal, 0.05 * 10 ** (shift / 20) * np.sin(2 * np.pi * 500 * time), 8000, subtype="FLOAT"
        )
        outputs.append(
            shift
            + calibrate_mix(
                FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event(), {}
            )
        )
    assert abs(outputs[0] - outputs[1]) < 0.01


def test_backing_bass_does_not_force_up_an_already_audible_voice(tmp_path):
    from backend.recordings.studio_calibration import calibrate_mix

    time = np.arange(8000 * 4) / 8000
    tone = np.sin(2 * np.pi * 700 * time)
    vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
    sf.write(vocal, 0.05 * tone, 8000, subtype="FLOAT")
    sf.write(backing, 0.2 * np.sin(2 * np.pi * 120 * time) + 0.005 * tone, 8000, subtype="FLOAT")
    report = {}
    gain = calibrate_mix(
        FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event(), report
    )
    assert gain < 0
    assert report["postMixCalibration"]["beforeVocalToBackingDb"] + gain <= 3.0
    assert report["postMixCalibration"]["perceivedBalanceLu"] + gain <= 0


def test_low_frequency_tails_do_not_determine_singing_level(tmp_path):
    from backend.recordings.studio_calibration import calibrate_mix

    gains = []
    for tail_seconds in [0, 8]:
        time = np.arange(8000 * (4 + tail_seconds)) / 8000
        voice = np.where(
            time < 4, 0.05 * np.sin(2 * np.pi * 700 * time), 0.03 * np.sin(2 * np.pi * 80 * time)
        )
        vocal, backing = tmp_path / "voice.wav", tmp_path / "backing.wav"
        sf.write(vocal, voice, 8000, subtype="FLOAT")
        sf.write(backing, 0.05 * np.sin(2 * np.pi * 700 * time), 8000, subtype="FLOAT")
        gains.append(
            calibrate_mix(
                FfmpegStudioMasterRenderer(ProcessRunner()), vocal, backing, threading.Event(), {}
            )
        )
    assert abs(gains[0] - gains[1]) < 0.5


def test_quiet_phrase_after_a_pause_is_not_lost_in_a_risen_backing():
    music = np.r_[np.full(100, -48.0), np.linspace(-48, -35, 100), np.full(100, -35.0)]
    voice = np.full(300, -42.0)
    voice[180:220] = -80
    voice[220:240] = -52
    result, _ = _protect_vocal_presence(np.zeros(300), voice, music)
    assert np.median(result[222:230]) >= 6.0
    np.testing.assert_array_equal(result[195:215], np.zeros(20))


def test_short_quiet_words_are_not_hidden_by_neighboring_loud_words():
    music = np.r_[np.full(200, -48.0), np.linspace(-48, -35, 100), np.full(200, -35.0)]
    voice = np.r_[np.full(300, -46.0), np.full(200, -34.0)]
    voice[:100] = -80
    voice[350:355] = -47
    voice[380:385] = -50
    result, _ = _protect_vocal_presence(np.zeros(500), voice, music)
    assert result[352] >= 8
    assert result[382] >= 10
    assert np.max(result[320:340]) <= 3


def test_short_loud_syllable_does_not_keep_the_neighboring_quiet_gain():
    music = np.r_[np.full(300, -48.0), np.linspace(-48, -40, 100), np.full(200, -40.0)]
    voice = np.full(600, -40.0)
    voice[:100] = -80
    voice[400] = -32
    gains, _ = _protect_vocal_presence(np.zeros(600), voice, music)
    output = voice + gains
    assert output[400] <= np.median(output[380:395]) + 3
    assert np.median(gains[380:395]) >= 7


@pytest.mark.parametrize("rise", [2, 4, 8, 15])
def test_presence_compensation_follows_the_measured_musical_rise(rise):
    music = np.r_[np.full(200, -40.0), np.linspace(-40, -40 + rise, 100), np.full(200, -40 + rise)]
    result, report = _protect_vocal_presence(np.zeros(500), np.full(500, -30.0), music)
    assert np.median(result[350:480]) == pytest.approx(min(rise, 9), abs=0.05)
    assert report["presenceBoostMaxDb"] <= min(rise, 9) + 1e-10
