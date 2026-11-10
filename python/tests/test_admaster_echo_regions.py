"""Regression tests for intermittent and multiple reference echo taps."""
import threading
import numpy as np
import soundfile as sf
from backend.recordings.studio_space import SpaceProfile, analyze_space, match_space, write_impulse


def test_echo_only_in_chorus(tmp_path):
    rate = 8000
    rng = np.random.default_rng(42)
    dry = rng.normal(0, .07, rate * 40)
    wet = dry.copy()
    shift = int(.36 * rate)
    start, end = 20 * rate, 36 * rate
    wet[start + shift:end] += .33 * dry[start:end - shift]
    path = tmp_path / 'chorus.wav'
    sf.write(path, wet, rate, subtype='FLOAT')
    profile = analyze_space(path, threading.Event())
    assert any(abs(delay - .36) < .005 for delay, _ in profile.echo_taps)


def test_two_echo_taps_and_impulse(tmp_path):
    rate = 8000
    rng = np.random.default_rng(20)
    dry = rng.normal(0, .07, rate * 30)
    wet = dry.copy()
    for delay, gain in ((.21, .32), (.42, .22)):
        n = round(delay * rate)
        wet[n:] += gain * dry[:-n]
    path = tmp_path / 'double.wav'
    sf.write(path, wet, rate, subtype='FLOAT')
    profile = analyze_space(path, threading.Event())
    assert any(abs(t - .21) < .005 for t, _ in profile.echo_taps)
    assert any(abs(t - .42) < .005 for t, _ in profile.echo_taps)
    impulse = tmp_path / 'impulse.wav'
    write_impulse(profile, impulse, rate, 1)
    ir, _ = sf.read(impulse)
    assert ir[round(.21 * rate)] > 0
    assert ir[round(.42 * rate)] > 0


def test_unrelated_existing_delay_does_not_cancel_original():
    reference = SpaceProfile(delay_seconds=.4, delay_gain=.28,
                             echo_taps=((.4,.28),(.8,.15)))
    existing = SpaceProfile(delay_seconds=.12, delay_gain=.3,
                            echo_taps=((.12,.3),))
    matched = match_space(reference, existing)
    assert matched.echo_taps == reference.echo_taps


def test_existing_matching_taps_are_not_duplicated():
    reference = SpaceProfile(delay_seconds=.4, delay_gain=.28,
                             echo_taps=((.4,.28),(.8,.15)))
    assert not match_space(reference, reference).echo_taps
