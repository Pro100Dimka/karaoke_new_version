"""Dense reference ambience reaches the adaptive sends without isolated tails."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

from backend.recordings.studio_adaptive_space import render_sends


def _write(root, name, audio, rate=8000):
    path = root / f"{name}.wav"
    sf.write(path, audio, rate, subtype="FLOAT")
    return path


def _dense_voice(rate=8000, seconds=18, band=(500, 3000)):
    rng = np.random.default_rng(341)
    length = rate * seconds
    envelope = np.repeat(rng.uniform(0.3, 1.0, seconds * 4), rate // 4)
    envelope = gaussian_filter1d(envelope, rate * 0.025)
    mono = (
        sosfilt(
            butter(2, band, fs=rate, btype="bandpass", output="sos"),
            rng.normal(0, 0.08, length),
        )
        * envelope
    )
    impulse = np.zeros(round(rate * 0.6))
    start = round(rate * 0.1)
    tail = rng.normal(size=len(impulse) - start)
    tail *= np.exp(-np.arange(len(tail)) / (rate * 0.12))
    impulse[start:] = tail * 0.34 / np.linalg.norm(tail)
    side = fftconvolve(mono, impulse)[:length]
    return np.column_stack((mono, mono)), np.column_stack((mono + side, mono - side))


def _side_ratio(audio):
    mid = audio.mean(axis=1)
    side = (audio[:, 0] - audio[:, 1]) / 2
    return np.mean(side**2) / np.mean(mid**2)


@pytest.mark.parametrize("band", [(150, 500), (500, 3000)])
def test_dense_reference_ambience_is_rendered_without_changing_dry_center(tmp_path, band):
    dry, reference = _dense_voice(band=band)
    source, ref = _write(tmp_path, "dry", dry), _write(tmp_path, "reference", reference)
    backing = _write(tmp_path, "backing", dry * 0.5)
    target = tmp_path / "master-voice.wav"
    report = render_sends(source, backing, target, threading.Event(), reference=ref)
    output = sf.read(target, always_2d=True)[0]
    assert report["applied"]
    assert "diffuse-field" in report["buses"]
    assert report["diffuseField"]["heldOutImprovement"] >= 0.05
    assert 0.02 < _side_ratio(output) <= _side_ratio(reference) * 1.1
    np.testing.assert_allclose(output.mean(axis=1), dry.mean(axis=1), atol=1e-7)
    assert output.shape == dry.shape
    # One stable return serves the performance: it cannot disappear on alternating words.
    for start in range(8000, len(output) - 8000, 4000):
        assert _side_ratio(output[start : start + 4000]) > 0.005


def test_existing_dense_ambience_is_not_added_twice(tmp_path):
    dry, reference = _dense_voice()
    source = _write(tmp_path, "wet", reference)
    backing = _write(tmp_path, "backing", dry * 0.5)
    target = tmp_path / "master-voice.wav"
    report = render_sends(
        source, backing, target, threading.Event(), reference=source, recorded_is_dry=False
    )
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])


@pytest.mark.parametrize("kind", ["no-reference", "dry", "pan", "unrelated"])
def test_diffuse_send_requires_delayed_reference_evidence(tmp_path, kind):
    dry, _ = _dense_voice()
    reference = dry.copy()
    if kind == "pan":
        reference *= np.array([1.2, 0.8])
    elif kind == "unrelated":
        noise = np.random.default_rng(22).normal(0, 0.02, len(dry))
        reference += np.column_stack((noise, -noise))
    source = _write(tmp_path, "dry", dry)
    ref = _write(tmp_path, "reference", reference) if kind != "no-reference" else None
    backing = _write(tmp_path, "backing", dry * 0.5)
    target = tmp_path / "master-voice.wav"
    report = render_sends(source, backing, target, threading.Event(), reference=ref)
    assert not report["applied"]
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])
