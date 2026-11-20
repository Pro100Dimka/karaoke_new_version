"""Bound FFT scratch memory while preserving every pYIN observation."""

import importlib

import librosa
import numpy as np
import pytest


def test_pyin_bounds_fft_batches_without_shortening_decoder_context(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import fast_pyin

    pitch = importlib.import_module("librosa.core.pitch")
    samples = 0.1 * np.sin(2 * np.pi * 220 * np.arange(16000 * 2) / 16000)
    parameters = dict(sr=16000, fmin=50, fmax=1500, frame_length=1024, hop_length=160)
    expected = librosa.pyin(samples, **parameters)
    original, widths = pitch.audio.autocorrelate, []

    def tracked(frames, *args, **kwargs):
        widths.append(frames.shape[-1])
        return original(frames, *args, **kwargs)

    monkeypatch.setattr(pitch.audio, "autocorrelate", tracked)
    actual = fast_pyin(librosa.pyin, samples, **parameters)
    for measured, reference in zip(actual, expected):
        np.testing.assert_array_equal(measured, reference)
    assert sum(widths) == 201
    assert max(widths) <= 128, "FFT scratch still grows across the entire analysis chunk"


@pytest.mark.parametrize("length", [1024, 3072])
@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("stereo", [False, True])
def test_difference_keeps_every_observation_exact(length, dtype, stereo):
    from backend.recordings.studio_pitch_difference import bounded_difference

    original = importlib.import_module("librosa.core.pitch")._cumulative_mean_normalized_difference
    samples = np.random.default_rng(491).normal(0, 0.1, 160 * 259 + length).astype(dtype)
    if stereo:
        samples = np.stack([samples, -samples])
    frames = librosa.util.frame(samples, frame_length=length, hop_length=160)
    expected = original(frames, 10, 320)
    actual = bounded_difference(frames, 10, 320, reference=original)
    np.testing.assert_array_equal(actual, expected)


def test_changed_difference_helper_keeps_current_callable_after_cache(monkeypatch):
    from backend.recordings.studio_pitch_probabilities import _engine

    pitch = importlib.import_module("librosa.core.pitch")
    original = pitch._cumulative_mean_normalized_difference
    assert _engine(librosa.pyin, librosa.__version__) is not librosa.pyin

    def current(y_frames, min_period, max_period):
        return original(y_frames, min_period, max_period)

    monkeypatch.setattr(pitch, "_cumulative_mean_normalized_difference", current)
    assert _engine(librosa.pyin, librosa.__version__) is librosa.pyin
