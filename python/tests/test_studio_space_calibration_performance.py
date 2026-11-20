"""Calibrate one return band without computing an unused second band."""

import math
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.domain_errors import DomainError
from backend.recordings import studio_space_analysis as analysis
from backend.recordings.studio_regional_returns import AmbienceRegion
from backend.recordings.studio_regional_space import _calibrate_region


def _source(path, rate, channels, final_frames):
    step = round(rate * 0.02)
    count = 2 * 150 * step + final_frames
    audio = np.random.default_rng(9271).normal(0, 0.17, (count, channels))
    sf.write(path, audio, rate, subtype="FLOAT")
    return count, step


def _full_band_envelopes(path):
    """Frozen pre-selection two-band analysis, preserving filter and sum order."""
    rows = []
    with sf.SoundFile(path) as source:
        if source.channels < 2 or source.samplerate <= 7000:
            return np.empty((0, 2, 2))
        step = max(1, round(source.samplerate * 0.02))
        bands = [
            butter(2, edges, fs=source.samplerate, btype="bandpass", output="sos")
            for edges in ((150, 500), (500, 3500))
        ]
        states = [np.zeros((len(band), 2, 2)) for band in bands]
        for block in source.blocks(blocksize=step * 150, always_2d=True):
            count = len(block) // step
            if not count:
                continue
            powers = []
            for index, band in enumerate(bands):
                samples, states[index] = sosfilt(band, block[:, :2], axis=0, zi=states[index])
                mid_side = np.column_stack(
                    (samples.mean(axis=1), np.diff(samples, axis=1)[:, 0] / 2)
                )
                powers.append(
                    np.mean(mid_side[: count * step].reshape(count, step, 2) ** 2, axis=1)
                )
            rows.append(np.stack(powers, axis=1))
    return np.concatenate(rows) if rows else np.empty((0, 2, 2))


@pytest.mark.parametrize("rate", [8000, 44100])
@pytest.mark.parametrize("channels", [1, 2])
@pytest.mark.parametrize("band_index", [0, 1])
@pytest.mark.parametrize("partial_has_frame", [False, True])
def test_selected_band_is_exact_and_filters_only_that_band(
    tmp_path, monkeypatch, rate, channels, band_index, partial_has_frame
):
    path = tmp_path / "source.wav"
    final_frames = 37 + round(rate * 0.02) * partial_has_frame
    _source(path, rate, channels, final_frames)
    expected = _full_band_envelopes(path)
    calls = 0

    def observe_filter(*args, **kwargs):
        nonlocal calls
        calls += 1
        return sosfilt(*args, **kwargs)

    monkeypatch.setattr(analysis, "sosfilt", observe_filter)
    default = analysis._field_envelopes(path, threading.Event())
    np.testing.assert_array_equal(default.view(np.uint64), expected.view(np.uint64))
    blocks = (2 + int(partial_has_frame)) if channels == 2 else 0
    assert calls == 2 * blocks
    calls = 0
    selected = analysis._field_envelopes(path, threading.Event(), band_index=band_index)
    np.testing.assert_array_equal(
        selected.view(np.uint64), expected[:, band_index : band_index + 1].view(np.uint64)
    )
    assert calls == blocks


@pytest.mark.parametrize("band_index", [0, 1])
def test_calibration_uses_one_band_and_keeps_exact_gains(tmp_path, monkeypatch, band_index):
    path = tmp_path / "return.wav"
    _source(path, 44100, 2, 919)
    wet = _full_band_envelopes(path)
    voice = wet * 1.4 + 1e-8
    added = wet * 0.003
    region = AmbienceRegion(0.26, 5.88, np.ones(31), (500, 3500), band_index, 0.2, 0.03, 1, "test")
    section = slice(round(region.start * 50), round(region.end * 50))
    dry_mid = float(voice[section, band_index, 0].sum())
    wet_mid, wet_side = wet[section, band_index].sum(axis=0)
    missing = max(0, region.ratio - region.existing_ratio)
    missing_side = max(0, missing * dry_mid - added[section, band_index, 1].sum())
    missing_mid = max(0, min(missing, 0.35**2) - 0.06**2)
    expected = (
        math.sqrt(missing_mid * dry_mid / max(float(wet_mid), 1e-20)),
        math.sqrt(missing_side / max(float(wet_side), 1e-20)),
    )
    calls = 0

    def observe_filter(*args, **kwargs):
        nonlocal calls
        calls += 1
        return sosfilt(*args, **kwargs)

    monkeypatch.setattr(analysis, "sosfilt", observe_filter)
    actual = _calibrate_region(voice, path, region, 0.06, added, threading.Event())
    assert actual == expected
    assert calls == 3


@pytest.mark.parametrize("band_index", [None, 1])
def test_band_selection_preserves_partial_block_cancellation(tmp_path, monkeypatch, band_index):
    path = tmp_path / "source.wav"
    _source(path, 8000, 2, 37)
    cancel = threading.Event()
    original_check = analysis._check_cancel
    calls = 0

    def cancel_on_partial(event):
        nonlocal calls
        calls += 1
        if calls == 3:
            event.set()
        original_check(event)

    monkeypatch.setattr(analysis, "_check_cancel", cancel_on_partial)
    with pytest.raises(DomainError, match="cancelled"):
        analysis._field_envelopes(path, cancel, band_index=band_index)
    assert calls == 3
