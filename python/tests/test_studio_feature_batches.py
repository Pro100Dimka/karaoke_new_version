"""Keep every spectral statistic while removing frame-by-frame reduction setup."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings import studio_adaptive_features as features


def _source(tmp_path, rate, channels):
    time = np.arange(round(rate * 4.153)) / rate
    rng = np.random.default_rng(372)
    voice = 0.07 * np.sin(2 * np.pi * (180 * time + 13 * time**2))
    voice += 0.03 * np.sin(2 * np.pi * 63 * time)
    voice += rng.normal(0, 0.015, len(time))
    samples = voice[:, None] if channels == 1 else np.column_stack((voice, -0.8 * voice))
    path = tmp_path / "voice.wav"
    sf.write(path, samples, rate, subtype="DOUBLE")
    step = round(rate * 0.02) / rate
    active = np.ones(int(np.ceil(len(time) / (rate * step))), dtype=bool)
    return path, active, np.zeros_like(active), step


def _original_normalization(spectrum, frequency, centers, masks):
    values = np.asarray(
        [
            float(np.mean(spectrum[mask]))
            if mask.any()
            else float(np.interp(center, frequency, spectrum))
            for center, mask in zip(centers, masks)
        ]
    )
    decibels = 10 * np.log10(np.maximum(values, 1e-14))
    anchor = float(np.percentile(decibels[(centers >= 200) & (centers <= 4000)], 75))
    anchor = max(anchor, float(np.max(decibels)) - 12)
    return decibels - anchor


def _original_summary(path, active, step):
    with sf.SoundFile(path) as audio:
        centers = np.geomspace(45, min(18000, audio.samplerate * 0.46), 96)
        count = max(64, round(audio.samplerate * 0.12))
        frequency = np.fft.rfftfreq(count, 1 / audio.samplerate)
        window = np.hanning(count)
        masks = [
            (frequency >= center / 2 ** (1 / 12)) & (frequency <= center * 2 ** (1 / 12))
            for center in centers
        ]
        spectra = [
            features._read_spectrum(audio, int(index), step, window)
            for index in features._spectrum_indices(active)
        ]
        frames = np.asarray(
            [_original_normalization(spectrum, frequency, centers, masks) for spectrum in spectra]
        )
        edges = [features._low_edge(spectrum, frequency) for spectrum in spectra]
        edges = [value for value in edges if value is not None]
        low = float(np.percentile(edges, 10)) if edges else 120.0
    return centers, np.median(frames, axis=0), frames, low


@pytest.mark.parametrize("rate,channels", [(8000, 1), (16000, 2), (44100, 2), (48000, 1)])
def test_spectral_summary_batches_reductions_without_changing_any_statistic(
    tmp_path, monkeypatch, rate, channels
):
    path, active, quiet, step = _source(tmp_path, rate, channels)
    expected = _original_summary(path, active, step)
    original, scalar_reductions = np.mean, []

    def tracked(value, *args, **kwargs):
        if np.ndim(value) == 1:
            scalar_reductions.append(1)
        return original(value, *args, **kwargs)

    monkeypatch.setattr(np, "mean", tracked)
    actual = features._spectral_summary(path, active, quiet, step, threading.Event())
    for observed, reference in zip(actual, expected):
        np.testing.assert_array_equal(observed, reference)
    assert len(scalar_reductions) <= 96, "Do not repeat all spectral reductions per frame"


def test_empty_spectral_summary_preserves_default_and_shape(tmp_path):
    path, active, quiet, step = _source(tmp_path, 8000, 2)
    actual = features._spectral_summary(path, active & False, quiet, step, threading.Event())
    assert actual[0].shape == actual[1].shape == (96,)
    np.testing.assert_array_equal(actual[1], np.zeros(96))
    assert actual[2].shape == (0, 96) and actual[3] == 55.0
