"""Shared decoding and FFTs must retain every original profile sample exactly."""

from dataclasses import fields
from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings.studio_adaptive_balance import _lead_profile, _presence_profile
from backend.recordings.studio_adaptive_mix import _duck_plan
from backend.recordings.studio_audio import _profile
from backend.recordings.studio_profiles import ProfileRequest, measure_profiles
from backend.recordings.studio_section_balance import _music_profiles
from backend.recordings.studio_section_tone import _voice_levels


def _source_pair(tmp_path):
    rate, count = 8000, 800 * 35 + 137
    paths = tmp_path / "voice.wav", tmp_path / "music.wav"
    rng = np.random.default_rng(109)
    for path, gain in zip(paths, (0.03, 0.12), strict=True):
        samples = rng.normal(0, gain, (count, 2))
        samples[rate : 2 * rate] = 0
        sf.write(path, samples, rate, subtype="DOUBLE")
    return paths, count


def _track_decodes(monkeypatch):
    original = sf.SoundFile.read
    decoded = {}

    def tracked(source, *args, **kwargs):
        samples = original(source, *args, **kwargs)
        name = Path(source.name)
        decoded[name] = decoded.get(name, 0) + len(samples)
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", tracked)
    return decoded


def _assert_fields(actual, expected):
    for item in fields(expected):
        first, second = getattr(actual, item.name), getattr(expected, item.name)
        if isinstance(first, np.ndarray):
            np.testing.assert_array_equal(first, second)
        else:
            assert first == second


def _individual_profiles(path, cancel, requests, *, frame_seconds=0.1):
    return tuple(
        _profile(
            path,
            cancel,
            center=r.center,
            voice_band=r.band_hz is not None,
            band_hz=r.band_hz or (300.0, 3500.0),
            frame_seconds=frame_seconds,
        )
        for r in requests
    )


@pytest.mark.parametrize("operation", [_duck_plan, _music_profiles])
def test_related_band_profiles_decode_each_input_once(tmp_path, monkeypatch, operation):
    paths, count = _source_pair(tmp_path)
    with monkeypatch.context() as original:
        original.setitem(operation.__globals__, "measure_profiles", _individual_profiles)
        expected = operation(*paths, threading.Event())
    assert expected is not None
    decoded = _track_decodes(monkeypatch)
    actual = operation(*paths, threading.Event())
    _assert_fields(actual, expected)
    assert decoded == dict.fromkeys(paths, count)


def _profile_requests():
    return tuple(
        ProfileRequest(center=center, band_hz=band)
        for center in (False, True)
        for band in (None, (80.0, 800.0), (800.0, 1500.0), (1500.0, 3500.0))
    )


@pytest.mark.parametrize("rate,channels", [(8000, 1), (8000, 2), (44100, 2), (44100, 6)])
@pytest.mark.parametrize("subtype", ["PCM_24", "DOUBLE"])
def test_multiband_profiles_equal_individual_profiles_exactly(
    tmp_path, monkeypatch, rate, channels, subtype
):
    step = round(rate * 0.1)
    samples = np.random.default_rng(521).normal(0, 0.07, (step * 35 + step // 3, channels))
    samples[step * 8 : step * 15] = 0
    path = tmp_path / "partial.wav"
    sf.write(path, samples, rate, subtype=subtype)
    requests = _profile_requests()
    expected = _individual_profiles(path, threading.Event(), requests)
    decoded = _track_decodes(monkeypatch)
    original_fft, transforms = np.fft.rfft, []

    def counted_fft(*args, **kwargs):
        transforms.append(args[0].shape)
        return original_fft(*args, **kwargs)

    monkeypatch.setattr(np.fft, "rfft", counted_fft)
    actual = measure_profiles(path, threading.Event(), (*requests, requests[0]))
    for first, second in zip(actual, [*expected, expected[0]], strict=True):
        np.testing.assert_array_equal(first, second)
    assert decoded == {path: len(samples)}
    assert len(transforms) == 6  # Two channel modes, two full groups and a partial frame.


@pytest.mark.parametrize("kind", ["cancelled", "invalid", "empty"])
def test_multiband_profiles_preserve_validation(tmp_path, kind):
    path = tmp_path / "input.wav"
    values = {"cancelled": [0.0] * 900, "invalid": [0.0, np.nan], "empty": []}
    sf.write(path, np.asarray(values[kind]), 8000, subtype="FLOAT")
    cancel = threading.Event()
    if kind == "cancelled":
        cancel.set()
    message = {"cancelled": "cancelled", "invalid": "invalid samples", "empty": "no audio"}
    with pytest.raises(DomainError, match=message[kind]):
        measure_profiles(path, cancel, _profile_requests())


@pytest.mark.parametrize("channels,antiphase", [(1, False), (2, False), (2, True), (6, False)])
def test_section_lead_bands_decode_once_and_keep_center_fallback(
    tmp_path, monkeypatch, channels, antiphase
):
    samples = np.random.default_rng(871).normal(0, 0.05, (800 * 35 + 137, channels))
    if antiphase:
        samples[:, 1] = -samples[:, 0]
    path = tmp_path / "voice.wav"
    sf.write(path, samples, 8000, subtype="DOUBLE")
    cancel = threading.Event()
    expected = (
        _lead_profile(path, cancel),
        *(
            _profile(path, cancel, voice_band=True, band_hz=band, center=True)
            for band in ((80.0, 800.0), (800.0, 1500.0), (1500.0, 3500.0))
        ),
        _presence_profile(path, cancel),
    )
    decoded = _track_decodes(monkeypatch)
    actual = _voice_levels(path, cancel)
    for first, second in zip(actual, expected, strict=True):
        np.testing.assert_array_equal(first, second)
    assert decoded == {path: len(samples)}
