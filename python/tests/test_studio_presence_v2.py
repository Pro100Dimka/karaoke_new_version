import numpy as np
from backend.recordings.studio_dynamics import _protect_vocal_presence


def test_climax_ride_is_bounded_and_greater_than_intro():
    n = 500
    music = np.r_[np.full(200, -38.), np.linspace(-38, -19, 150), np.full(150, -19.)]
    voice = np.full(n, -27.)
    gains = np.zeros(n)
    result, report = _protect_vocal_presence(gains, voice, music)
    assert 0 <= report['presenceBoostMaxDb'] <= 5
    assert np.median(result[350:480]) > np.median(result[20:150]) + 2
    assert np.all(result >= gains)


def test_silence_not_boosted():
    music = np.r_[np.full(200, -38.), np.full(300, -19.)]
    voice = np.r_[np.full(200, -27.), np.full(300, -90.)]
    result, _ = _protect_vocal_presence(np.zeros(500), voice, music)
    assert np.max(result[240:]) == 0


def test_invalid_profiles_are_safe():
    gains = np.zeros(20)
    result, _ = _protect_vocal_presence(gains, np.full(20, np.nan), np.zeros(20))
    np.testing.assert_array_equal(result, gains)


def test_presence_protection_never_adds_more_than_five_db_to_attenuated_voice():
    voice = np.full(120, -12.0)
    music = np.full(120, -16.0)
    gains = np.full(120, -30.0)
    result, report = _protect_vocal_presence(gains, voice, music)
    assert np.all(result - gains <= 5.0 + 1e-9)
    assert report['presenceBoostMaxDb'] <= 5.0
