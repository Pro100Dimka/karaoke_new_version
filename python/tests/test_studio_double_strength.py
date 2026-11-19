"""Automatic double strength reaches own-voice PCM without changing vocal placement."""

from dataclasses import replace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_double_analysis import analyze_doubling
from backend.recordings.studio_doubling import render_double_layers
from backend.recordings.studio_layer_render import render_vocal_layers
from backend.recordings.studio_layer_types import VocalLayerRegion


def _voices(rate, seconds=12):
    time = np.arange(rate * seconds) / rate
    envelope = np.clip(time % 1.5 / 0.03, 0, 1) * np.clip((0.85 - time % 1.5) / 0.03, 0, 1)
    pitch = 150 + 18 * np.sin(2 * np.pi * 0.11 * time) + 2 * np.sin(2 * np.pi * 5 * time)
    phases = [2 * np.pi * np.cumsum(pitch + offset) / rate for offset in (0, 25)]
    reference = sum(np.sin(h * phases[0]) / h for h in range(1, 14)) * 0.04 * envelope
    own = sum(np.sin(h * phases[1] + 0.13 * h) / h**1.1 for h in range(1, 14))
    return time, reference, own * 0.04 * envelope, envelope


def _known_double(root, rate, strength):
    time, reference, own, envelope = _voices(rate)
    left = np.interp(
        time - (0.020 + 0.003 * np.sin(2 * np.pi * 0.37 * time)), time, reference, left=0
    )
    right = np.interp(
        time - (0.027 + 0.003 * np.sin(2 * np.pi * 0.43 * time + 0.9)), time, reference, left=0
    )
    selected = (time >= 3) & (time < 9)
    original = reference[:, None] + strength * np.column_stack((left, right)) * selected[:, None]
    source, guide = root / "own.wav", root / "reference.wav"
    sf.write(source, np.column_stack((own, own)), rate, subtype="FLOAT")
    sf.write(guide, original, rate, subtype="FLOAT")
    regions, _ = analyze_doubling(guide, threading.Event())
    return source, guide, regions, time, envelope


def _side_mid_db(samples):
    mid, side = samples.mean(1), (samples[:, 0] - samples[:, 1]) / 2
    return 10 * np.log10(max(np.mean(side**2), 1e-25) / max(np.mean(mid**2), 1e-25))


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("strength", [0.12, 0.35])
def test_measured_reference_strength_survives_render_without_raising_vocal_balance(
    tmp_path, rate, strength
):
    source, guide, regions, time, envelope = _known_double(tmp_path, rate, strength)
    assert regions
    before = source.read_bytes(), guide.read_bytes()
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "layered.wav", regions, threading.Event()
    )
    output, actual_rate = sf.read(path, always_2d=True)
    dry, reference = [sf.read(path, always_2d=True)[0] for path in (source, guide)]
    full, middle = np.zeros(len(time), bool), np.zeros(len(time), bool)
    for region in regions:
        full |= (time >= region.start) & (time < region.end)
        middle |= (time >= region.start + 0.08) & (time < region.end - 0.08)
    middle &= envelope > 0.95
    assert abs(_side_mid_db(output[middle]) - _side_mid_db(reference[middle])) < 2
    assert abs(10 * np.log10(np.mean(output[full] ** 2) / np.mean(dry[full] ** 2))) < 0.15
    np.testing.assert_array_equal(output[~full], dry[~full])
    assert actual_rate == rate and output.shape == dry.shape
    assert before == (source.read_bytes(), guide.read_bytes())
    assert report["drySignalPreservedUpToRegionalGain"]
    assert report["doublingCalibration"]["applied"]
    assert all(0 < region.gain <= 0.175 for region in regions)


def _pair(start=0.5, end=3.5, target=-16):
    return [
        VocalLayerRegion(
            start,
            end,
            "double",
            0.12,
            delay_ms=delay,
            pan=pan,
            modulation_ms=2,
            target_side_to_mid_db=target,
        )
        for delay, pan in ((20, -1), (27, 1))
    ]


def test_manual_layers_keep_the_existing_dry_and_wet_amplitudes(tmp_path):
    rate = 16000
    time = np.arange(rate * 4) / rate
    dry = np.repeat((0.08 * np.sin(2 * np.pi * 220 * time))[:, None], 2, axis=1)
    source, wet_path = tmp_path / "own.wav", tmp_path / "manual-wet.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    regions = [VocalLayerRegion(0.5, 3.5, "double", 0.15, delay_ms=23, pan=-0.7, modulation_ms=2)]
    render_double_layers(source, wet_path, regions, threading.Event())
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", regions, threading.Event()
    )
    expected = sf.read(source, always_2d=True)[0] + sf.read(wet_path, always_2d=True)[0]
    np.testing.assert_allclose(sf.read(path, always_2d=True)[0], expected, atol=1e-8, rtol=0)
    assert report["dryPreserved"]


def test_automatic_spatial_calibration_has_an_explicit_mono_fallback(tmp_path):
    rate = 44100
    _, _, own, _ = _voices(rate, 4)
    source = tmp_path / "mono.wav"
    sf.write(source, own, rate, subtype="FLOAT")
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", _pair(), threading.Event()
    )
    output, actual_rate = sf.read(path)
    assert output.shape == own.shape and actual_rate == rate
    assert np.max(abs(output - own)) > 0.001
    assert report["doublingCalibration"]["reason"] == "mono-spatial-fit-unavailable"


@pytest.mark.parametrize("kind", ["noise", "antiphase"])
def test_unsupported_source_cannot_receive_an_automatic_strength_boost(tmp_path, kind):
    rate = 16000
    time, _, own, _ = _voices(rate, 4)
    dry = np.column_stack((own, own))
    if kind == "noise":
        noise = (time > 0.8) & (time < 3.3)
        dry[noise] = np.random.default_rng(71).normal(0, 0.015, (noise.sum(), 2))
    else:
        dry[:, 1] *= -1
    source = tmp_path / "own.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", _pair(1, 3), threading.Event()
    )
    np.testing.assert_array_equal(
        sf.read(path, always_2d=True)[0], sf.read(source, always_2d=True)[0]
    )
    assert not report["applied"]


def test_strong_unreachable_target_is_reported_with_bounded_return_and_smooth_edges(tmp_path):
    rate = 48000
    time = np.arange(rate * 4) / rate
    own = 0.08 * np.sin(2 * np.pi * (175 * time + 0.6 * np.sin(2 * np.pi * 0.7 * time)))
    source = tmp_path / "own.wav"
    sf.write(source, np.column_stack((own, own)), rate, subtype="FLOAT")
    # Nearly identical delayed returns cannot supply a strong independent side,
    # even at the maximum allowed per-layer gain.
    regions = [
        replace(region, delay_ms=20 + index * 0.1, modulation_ms=0)
        for index, region in enumerate(_pair(target=-3.1))
    ]
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", regions, threading.Event()
    )
    output = sf.read(path, always_2d=True)[0]
    assert np.isfinite(output).all() and np.max(abs(output)) <= 2 * np.max(abs(own)) + 1e-7
    assert any(row["targetUnreached"] for row in report["doublingCalibration"]["regions"])
    assert max(row["maxLayerGain"] for row in report["doublingCalibration"]["regions"]) <= 1
    assert np.max(abs(np.diff(output, axis=0))) < 0.01


def test_overlapping_automatic_pairs_use_one_smooth_complete_vocal_budget(tmp_path):
    rate = 44100
    _, _, own, _ = _voices(rate, 4)
    source = tmp_path / "own.wav"
    sf.write(source, np.column_stack((own, own)), rate, subtype="FLOAT")
    regions = _pair(0.5, 2.5) + _pair(2, 3.5, -12)
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", regions, threading.Event()
    )
    output = sf.read(path, always_2d=True)[0]
    dry = sf.read(source, always_2d=True)[0]
    middle = slice(round(rate * 0.5), round(rate * 3.5))
    assert abs(10 * np.log10(np.mean(output[middle] ** 2) / np.mean(dry[middle] ** 2))) < 0.15
    np.testing.assert_array_equal(output[: round(rate * 0.5)], dry[: round(rate * 0.5)])
    assert any(
        row.get("reason") == "overlapping-layer-regions"
        for row in report["doublingCalibration"]["regions"]
    )


@pytest.mark.parametrize("target", [float("nan"), float("inf"), -31.0])
def test_invalid_automatic_target_does_not_touch_audio(tmp_path, target):
    rate = 16000
    _, _, own, _ = _voices(rate, 4)
    source = tmp_path / "own.wav"
    sf.write(source, own, rate, subtype="FLOAT")
    regions = [replace(region, target_side_to_mid_db=target) for region in _pair()]
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", regions, threading.Event()
    )
    assert path == source and not report["applied"]


def test_unpaired_automatic_metadata_cannot_change_an_overlapping_manual_return(tmp_path):
    rate = 16000
    _, _, own, _ = _voices(rate, 4)
    source = tmp_path / "own.wav"
    sf.write(source, np.column_stack((own, own)), rate, subtype="FLOAT")
    automatic = _pair(0.5, 3.5)[0]
    manual = replace(automatic, target_side_to_mid_db=None, delay_ms=32, pan=0.5)
    baseline, _ = render_vocal_layers(
        None, source, source, tmp_path / "manual.wav", [manual], threading.Event()
    )
    actual, report = render_vocal_layers(
        None, source, source, tmp_path / "mixed.wav", [manual, automatic], threading.Event()
    )
    np.testing.assert_array_equal(sf.read(actual)[0], sf.read(baseline)[0])
    assert report["skippedRegions"] == 1


def test_return_fit_is_invariant_to_own_recording_level(tmp_path):
    source, _, regions, _, _ = _known_double(tmp_path, 44100, 0.35)
    dry, rate = sf.read(source, always_2d=True)
    outputs = []
    for index, level in enumerate((0.1, 1.0)):
        scaled = tmp_path / f"own-{index}.wav"
        sf.write(scaled, dry * level, rate, subtype="FLOAT")
        path, _ = render_vocal_layers(
            None, scaled, scaled, tmp_path / f"out-{index}.wav", regions, threading.Event()
        )
        outputs.append(sf.read(path, always_2d=True)[0] / level)
    np.testing.assert_allclose(outputs[0], outputs[1], atol=1e-7, rtol=0)


def test_double_fit_checks_cancellation_in_the_final_bounded_read(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError
    from backend.recordings.studio_double_calibration import calibrate_double_return

    rate = 8000
    time = np.arange(rate) / rate
    dry = np.column_stack([0.1 * np.sin(2 * np.pi * 175 * time)] * 2)
    source, wet, target = [tmp_path / f"{name}.wav" for name in ("own", "wet", "calibrated")]
    sf.write(source, dry, rate, subtype="FLOAT")
    sf.write(wet, dry * 0.1, rate, subtype="FLOAT")
    before = source.read_bytes(), wet.read_bytes()
    cancel, read = threading.Event(), sf.SoundFile.read

    def cancel_read(audio, frames=-1, *args, **kwargs):
        assert 0 < frames <= 32768
        samples = read(audio, frames, *args, **kwargs)
        cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", cancel_read)
    with pytest.raises(DomainError, match="cancel"):
        calibrate_double_return(
            source, wet, target, _pair(0.1, 0.9), (time, np.ones(len(time))), cancel
        )
    assert before == (source.read_bytes(), wet.read_bytes())
    assert not target.exists()


def test_mono_overlaps_do_not_flip_an_already_playing_return(tmp_path):
    rate = 48000
    time = np.arange(rate * 4) / rate
    own = 0.08 * np.sin(2 * np.pi * 175 * time)
    source = tmp_path / "mono.wav"
    sf.write(source, own, rate, subtype="FLOAT")
    regions = [replace(region, modulation_ms=0) for region in _pair(0.5, 2.5) + _pair(2, 3.5)]
    path, report = render_vocal_layers(
        None, source, source, tmp_path / "out.wav", regions, threading.Event()
    )
    output = sf.read(path)[0]
    assert np.max(abs(np.diff(output))) < 0.005
    assert all(row["returnPolarity"] == 1 for row in report["doublingCalibration"]["regions"])
