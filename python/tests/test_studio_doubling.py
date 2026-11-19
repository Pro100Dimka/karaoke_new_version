"""Voiced doubles remain audible in mono and come only from the user's direct PCM."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_layer_types import VocalLayerRegion


def _render(*args, **kwargs):
    from backend.recordings.studio_doubling import render_double_layers

    return render_double_layers(*args, **kwargs)


def _voice(rate, seconds=4):
    time = np.arange(round(rate * seconds) + 17) / rate
    return 0.08 * np.sin(2 * np.pi * 220 * time) + 0.03 * np.sin(2 * np.pi * 660 * time)


@pytest.mark.parametrize("channels", [1, 2])
def test_modulated_double_adds_a_voiced_layer_that_survives_mono(tmp_path, channels):
    rate = 16000
    mono = _voice(rate)
    dry = np.repeat(mono[:, None], channels, axis=1)
    source, target = tmp_path / "direct.wav", tmp_path / "double-wet.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    original = source.read_bytes()
    regions = [
        VocalLayerRegion(0.4, 3.5, "double", 0.25, delay_ms=20, pan=-0.7, modulation_ms=3),
        VocalLayerRegion(0.4, 3.5, "double", 0.25, delay_ms=27, pan=0.7, modulation_ms=3),
    ]

    report = _render(source, target, regions, threading.Event(), channels=channels)

    wet, actual_rate = sf.read(target, always_2d=True)
    middle = slice(rate, rate * 3)
    mono_ratio = np.mean(wet[middle].mean(axis=1) ** 2) / np.mean(mono[middle] ** 2)
    assert mono_ratio > 0.02  # Antisymmetric ambience has no audible mono double.
    assert wet.shape == dry.shape and actual_rate == rate
    assert np.isfinite(wet).all()
    assert source.read_bytes() == original
    np.testing.assert_array_equal(wet[: round(rate * 0.4)], 0)
    np.testing.assert_array_equal(wet[round(rate * 3.5) :], 0)
    assert report["applied"] and report["regionCount"] == 2
    assert report["source"] == "user-direct"


@pytest.mark.parametrize("rate", [8000, 44100, 48000])
def test_fractional_delay_preserves_the_source_pitch_and_exact_timeline(tmp_path, rate):
    time = np.arange(rate * 2 + 13) / rate
    voice = 0.1 * np.sin(2 * np.pi * 200 * time)
    source, target = tmp_path / "direct.wav", tmp_path / "wet.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    region = VocalLayerRegion(0.2, 1.8, "double", 0.3, delay_ms=12.375)
    _render(source, target, [region], threading.Event())
    actual, actual_rate = sf.read(target)
    middle = (time > 0.4) & (time < 1.6)
    expected = 0.03 * np.sin(2 * np.pi * 200 * (time - 0.012375))
    np.testing.assert_allclose(actual[middle], expected[middle], atol=1e-6, rtol=0)
    assert actual_rate == rate and len(actual) == len(voice)


@pytest.mark.parametrize("pan", [-1.0, 0.0, 1.0])
def test_mono_source_uses_positive_equal_power_pan(tmp_path, pan):
    rate = 16000
    source, target = tmp_path / "direct.wav", tmp_path / "wet.wav"
    sf.write(source, _voice(rate, 2), rate, subtype="FLOAT")
    region = VocalLayerRegion(0.2, 1.8, "double", 0.2, delay_ms=20, pan=pan)
    _render(source, target, [region], threading.Event(), channels=2)
    wet, _ = sf.read(target, always_2d=True)
    gains = np.sqrt([(1 - pan) / 2, (1 + pan) / 2])
    if pan == 0:
        np.testing.assert_array_equal(wet[:, 0], wet[:, 1])
        assert np.mean(wet.mean(axis=1) ** 2) > 1e-6
    else:
        np.testing.assert_array_equal(wet[:, int(pan < 0)], 0)
    assert wet.shape[1] == 2 and np.sum(gains**2) == pytest.approx(1)


def test_stereo_source_is_not_collapsed_before_the_linked_delay(tmp_path):
    rate = 16000
    voice = _voice(rate, 2)
    source, target = tmp_path / "direct.wav", tmp_path / "wet.wav"
    sf.write(source, np.column_stack((voice, -0.7 * voice)), rate, subtype="FLOAT")
    region = VocalLayerRegion(0.2, 1.8, "double", 0.2, delay_ms=20, modulation_ms=2)
    _render(source, target, [region], threading.Event())
    wet, _ = sf.read(target, always_2d=True)
    np.testing.assert_allclose(wet[:, 1], -0.7 * wet[:, 0], atol=2e-8, rtol=0)
    assert np.max(np.abs(wet)) > 0.005


def test_region_fades_do_not_create_clicks_or_copy_the_previous_phrase(tmp_path):
    rate = 8000
    source, target = tmp_path / "direct.wav", tmp_path / "wet.wav"
    voice = np.ones(rate * 2, dtype=np.float32) * 0.1
    sf.write(source, voice, rate, subtype="FLOAT")
    region = VocalLayerRegion(0.5, 1.5, "double", 0.3, delay_ms=30)
    _render(source, target, [region], threading.Event())
    wet, _ = sf.read(target)
    np.testing.assert_array_equal(wet[: round(rate * 0.53)], 0)
    np.testing.assert_array_equal(wet[round(rate * 1.5) :], 0)
    assert np.max(np.abs(np.diff(wet))) < 0.0004
    assert np.max(wet) == pytest.approx(0.03, abs=1e-8)


def test_silent_source_never_generates_a_voice(tmp_path):
    rate = 44100
    source, target = tmp_path / "silent.wav", tmp_path / "wet.wav"
    sf.write(source, np.zeros((rate * 2, 2)), rate, subtype="FLOAT")
    region = VocalLayerRegion(0, 2, "double", 0.35, delay_ms=25, modulation_ms=4)
    report = _render(source, target, [region], threading.Event())
    np.testing.assert_array_equal(sf.read(target)[0], 0)
    assert not report["applied"]


def test_double_render_is_deterministic_across_io_block_sizes(tmp_path, monkeypatch):
    from backend.recordings import studio_doubling

    rate = 44100
    source = tmp_path / "direct.wav"
    sf.write(source, _voice(rate), rate, subtype="FLOAT")
    regions = [VocalLayerRegion(0.2, 3.8, "double", 0.25, delay_ms=23, modulation_ms=4)]
    first, second = tmp_path / "first.wav", tmp_path / "second.wav"
    _render(source, first, regions, threading.Event())
    monkeypatch.setattr(studio_doubling, "_BLOCK_FRAMES", 4096)
    _render(source, second, regions, threading.Event())
    np.testing.assert_array_equal(sf.read(first)[0], sf.read(second)[0])


def test_double_render_honors_cancellation_and_bounds_reads(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError

    rate = 48000
    source, target = tmp_path / "direct.wav", tmp_path / "wet.wav"
    sf.write(source, _voice(rate), rate, subtype="FLOAT")
    original = source.read_bytes()
    region = VocalLayerRegion(0.2, 3.8, "double", 0.25, delay_ms=25, modulation_ms=3)
    cancel = threading.Event()
    read = sf.SoundFile.read

    def bounded_read(audio, frames=-1, *args, **kwargs):
        assert 0 < frames <= 65536 + rate // 8
        samples = read(audio, frames, *args, **kwargs)
        cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", bounded_read)
    with pytest.raises(DomainError, match="cancel"):
        _render(source, target, [region], cancel)
    assert source.read_bytes() == original
