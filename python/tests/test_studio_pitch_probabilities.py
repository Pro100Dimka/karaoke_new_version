"""Exact pYIN probabilities with bounded repeated statistical setup."""

import importlib
import threading

import librosa
import numpy as np
import pytest
from scipy import stats


def test_pitch_estimator_builds_the_trough_prior_once(monkeypatch):
    from backend.recordings.studio_pitch_analysis import _estimate

    times = np.arange(16000 * 2) / 16000
    signal = 0.1 * np.sin(2 * np.pi * 220 * times)
    original, calls = stats.boltzmann.pmf, []

    def tracked(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(stats.boltzmann, "pmf", tracked)
    frequency, confidence, _ = _estimate(signal, threading.Event())
    assert np.count_nonzero(frequency) > 180
    assert np.isfinite(confidence).all()
    assert len(calls) == 1


@pytest.mark.parametrize("frame_length", [1024, 3072])
@pytest.mark.parametrize("kind", ["bass", "glide", "noise", "silence", "stereo"])
def test_fast_pyin_matches_all_reference_arrays_exactly(kind, frame_length):
    from backend.recordings.studio_pitch_probabilities import fast_pyin

    time = np.arange(16000 * 2 + 31) / 16000
    hz = 65 if kind == "bass" else 180 + 25 * time
    phase = 2 * np.pi * np.cumsum(np.broadcast_to(hz, time.shape)) / 16000
    samples = 0.1 * np.sin(phase) + 0.04 * np.sin(phase * 2)
    if kind == "noise":
        samples = np.random.default_rng(44).normal(0, 0.08, len(time))
    if kind == "silence":
        samples = np.zeros(len(time))
    if kind == "stereo":
        samples = np.stack([samples, -samples])
    parameters = dict(
        sr=16000,
        fmin=50,
        fmax=1500,
        frame_length=frame_length,
        hop_length=160,
        resolution=0.1,
        center=True,
        pad_mode="constant",
    )
    expected = librosa.pyin(samples, **parameters)
    actual = fast_pyin(librosa.pyin, samples, **parameters)
    for measured, reference in zip(actual, expected):
        np.testing.assert_array_equal(measured, reference)


def test_fast_pyin_never_changes_library_globals():
    from backend.recordings.studio_pitch_probabilities import _engine

    module = importlib.import_module("librosa.core.pitch")
    helper, original = module.__pyin_helper, librosa.pyin
    engine = _engine(original, librosa.__version__)
    assert engine is not original
    assert module.__pyin_helper is helper
    assert librosa.pyin is original
    assert engine.__globals__ is not original.__globals__


def test_unsupported_library_version_keeps_original_engine():
    from backend.recordings.studio_pitch_probabilities import _engine

    assert _engine(librosa.pyin, "future-version") is librosa.pyin


def test_wrapped_or_instrumented_pyin_is_preserved():
    from backend.recordings.studio_pitch_probabilities import _engine

    def instrumented(*args, **kwargs):
        return librosa.pyin(*args, **kwargs)

    assert _engine(instrumented, librosa.__version__) is instrumented


def test_changed_private_helper_falls_back_even_after_cached_engine(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    module = importlib.import_module("librosa.core.pitch")
    assert _engine(librosa.pyin, librosa.__version__) is not librosa.pyin
    monkeypatch.setattr(module, "__pyin_helper", lambda *args: None)
    assert _engine(librosa.pyin, librosa.__version__) is librosa.pyin


def test_large_period_range_uses_original_helper_without_allocating_prior(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _helper

    calls = []
    expected = (np.zeros((1, 2, 3)), np.zeros((1, 3)))

    def original(*args):
        calls.append(args)
        return expected

    def unexpected(*args, **kwargs):
        raise AssertionError("Large quadratic prior must not be allocated")

    monkeypatch.setattr(stats.boltzmann, "pmf", unexpected)
    yin = np.zeros((513, 3))
    actual = _helper(
        yin,
        yin,
        16000,
        np.linspace(0, 1, 101),
        2,
        np.ones(100) / 100,
        0.01,
        10,
        50,
        589,
        10,
        reference=original,
    )
    assert actual is expected and len(calls) == 1
    assert calls[0][0] is yin


def test_probability_edges_and_empty_troughs_match_original_helper():
    from backend.recordings.studio_pitch_probabilities import _helper

    original = importlib.import_module("librosa.core.pitch").__pyin_helper
    frames = np.random.default_rng(197).uniform(0, 1.2, (311, 39))
    frames[:, 0] = 0
    frames[:, 1] = 1
    frames[:, 2] = np.linspace(0, 1, len(frames))
    frames[:, 3] = frames[::-1, 2]
    shifts = np.random.default_rng(198).uniform(-0.3, 0.3, frames.shape)
    thresholds = np.linspace(0, 1, 101)
    beta = np.diff(stats.beta.cdf(thresholds, 2, 18))
    arguments = (frames, shifts, 16000, thresholds, 2, beta, 0.01, 10, 50, 589, 10)
    expected = original(*arguments)
    actual = _helper(*arguments, reference=original)
    for measured, reference in zip(actual, expected):
        np.testing.assert_array_equal(measured, reference)
