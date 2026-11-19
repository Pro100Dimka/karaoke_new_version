"""Independent doubles stay present when a phrase becomes wider, not merely louder."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_double_analysis import analyze_doubling
from backend.recordings.studio_layer_types import VocalLayerRegion
from backend.recordings.studio_layer_render import render_vocal_layers


def _reference(rate=16000):
    time = np.arange(rate * 12) / rate
    pitch = 150 + 18 * np.sin(2 * np.pi * 0.11 * time) + 2 * np.sin(2 * np.pi * 5 * time)
    phase = 2 * np.pi * np.cumsum(pitch) / rate
    envelope = np.clip((time % 1.5) / 0.02, 0, 1) * np.clip((0.85 - time % 1.5) / 0.02, 0, 1)
    # All four words contain the same independently modulated return. Alternate
    # words have stronger side energy; the third word is sung more quietly.
    envelope *= np.where((time >= 6) & (time < 7.5), 0.45, 1.0)
    color = 1 + 0.35 * (np.floor(time / 1.5).astype(int) % 2)
    voice = sum(np.sin(h * phase) / h**color for h in range(1, 14)) * 0.04 * envelope
    left = np.interp(time - (0.020 + 0.003 * np.sin(2 * np.pi * 0.37 * time)), time, voice, left=0)
    right = np.interp(
        time - (0.027 + 0.003 * np.sin(2 * np.pi * 0.43 * time + 0.9)), time, voice, left=0
    )
    strength = np.where((np.floor((time - 3) / 1.5).astype(int) % 2) == 0, 0.25, 1.0)
    strength *= (time >= 3) & (time < 9)
    reference = voice[:, None] + strength[:, None] * np.column_stack((left, right))
    return time, voice, reference


def _check_rendered_words(root, rate, time, regions):
    envelope = np.clip(time % 1.5 / 0.02, 0, 1) * np.clip((0.85 - time % 1.5) / 0.02, 0, 1)
    own = 0.06 * np.sin(2 * np.pi * (185 * time + 0.6 * np.sin(2 * np.pi * 0.7 * time))) * envelope
    source = root / "own.wav"
    sf.write(source, np.column_stack((own, own)), rate, subtype="FLOAT")
    before = source.read_bytes()
    path, report = render_vocal_layers(
        None, source, source, root / "out.wav", regions, threading.Event()
    )
    output = sf.read(path, always_2d=True)[0]
    dry = sf.read(source, always_2d=True)[0]
    for start in (3, 4.5, 6, 7.5):
        vowel = (time >= start + 0.1) & (time < start + 0.75)
        assert np.mean((output[vowel, 0] - output[vowel, 1]) ** 2) > 1e-7
    absent = (time < 2.8) | (time > 9.2)
    np.testing.assert_array_equal(output[absent], dry[absent])
    assert source.read_bytes() == before and report["applied"]


def test_independent_double_continues_across_wide_and_quiet_words_but_not_dry_sections(tmp_path):
    rate = 16000
    time, _, reference = _reference(rate)
    path = tmp_path / "reference.wav"
    sf.write(path, reference, rate, subtype="FLOAT")
    regions, report = analyze_doubling(path, threading.Event())
    selected = np.zeros(len(time), dtype=bool)
    for region in regions:
        selected |= (time >= region.start) & (time < region.end)
    for start in (3, 4.5, 6, 7.5):
        vowel = (time >= start + 0.1) & (time < start + 0.75)
        assert np.mean(selected[vowel]) > 0.5, f"Double missing on word at {start} s"
    assert not selected[time < 2.8].any()
    assert not selected[time > 9.2].any()
    assert report["applied"]
    assert any(region.target_side_to_mid_db > -3 for region in regions)
    _check_rendered_words(tmp_path, rate, time, regions)


@pytest.mark.parametrize("kind", ["antiphase", "moving_pan", "noise"])
def test_wide_signal_without_independent_voiced_motion_does_not_authorize_double(tmp_path, kind):
    time, voice, _ = _reference()
    if kind == "antiphase":
        reference = np.column_stack((voice, -0.95 * voice))
    elif kind == "moving_pan":
        pan = 0.8 * np.sin(2 * np.pi * 0.4 * time)
        reference = np.column_stack((voice * (1 + pan), voice * (1 - pan)))
    else:
        side = np.random.default_rng(903).normal(0, 0.08, len(time))
        reference = np.column_stack((voice + side, voice - side))
    path = tmp_path / "reference.wav"
    sf.write(path, reference, 16000, subtype="FLOAT")
    regions, report = analyze_doubling(path, threading.Event())
    assert not regions and not report["applied"]


@pytest.mark.parametrize("target", [-2.0, 1.0, 10000.0])
def test_supported_wide_targets_use_bounded_fit_and_report_limits(tmp_path, target):
    rate = 16000
    time = np.arange(rate * 4) / rate
    voice = 0.08 * np.sin(2 * np.pi * (175 * time + 0.6 * np.sin(2 * np.pi * 0.7 * time)))
    source = tmp_path / "own.wav"
    sf.write(source, np.column_stack((voice, voice)), rate, subtype="FLOAT")
    regions = [
        VocalLayerRegion(
            0.5,
            3.5,
            "double",
            0.175,
            delay_ms=delay,
            pan=pan,
            modulation_ms=2,
            target_side_to_mid_db=target,
        )
        for delay, pan in ((20, -1), (27, 1))
    ]
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", regions, threading.Event()
    )
    samples = sf.read(path, always_2d=True)[0]
    assert report["applied"] and report["skippedRegions"] == 0
    assert np.isfinite(samples).all()
    assert np.max(abs(samples)) <= 2 * np.max(abs(voice)) + 1e-7
    rows = report["doublingCalibration"]["regions"]
    assert max(row["maxLayerGain"] for row in rows) <= 1
    if target > 0:
        assert all(row["targetUnreached"] for row in rows)
