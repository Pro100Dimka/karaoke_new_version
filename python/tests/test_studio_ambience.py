"""Vocal-triggered attenuation belongs only to reconstructed ambience returns."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import fftconvolve

from backend.recordings.studio_space import SpaceProfile, _render_separate_buses, write_impulse


def _phrases(rate, channels=2):
    time = np.arange(round(rate * 4.2) + 17) / rate
    phrase = ((time >= 0.2) & (time < 1.5)) | ((time >= 3) & (time < 3.8))
    mono = 0.06 * np.sin(2 * np.pi * 200 * time) + 0.02 * np.sin(2 * np.pi * 600 * time)
    return np.column_stack([mono * phrase * (1 - index * 0.2) for index in range(channels)])


def _unducked_return(tmp_path, samples, profile, rate):
    impulse = tmp_path / "expected-impulse.wav"
    write_impulse(profile, impulse, rate, samples.shape[1])
    response, _ = sf.read(impulse, always_2d=True)
    wet = fftconvolve(samples, response, axes=0)[: len(samples)]
    gain = min(
        profile.reverb_gain * np.sqrt(np.sum(samples**2) / np.sum(wet**2)),
        0.5 * np.max(np.abs(samples)) / np.max(np.abs(wet)),
    )
    return wet * gain


@pytest.mark.parametrize("channels", [1, 2])
def test_reverb_is_lower_under_the_vocal_and_returns_naturally_in_the_gap(tmp_path, channels):
    rate = 8000
    source, output = tmp_path / "voice.wav", tmp_path / "result.wav"
    sf.write(source, _phrases(rate, channels), rate, subtype="FLOAT")
    original = source.read_bytes()
    dry, _ = sf.read(source, always_2d=True)
    profile = SpaceProfile(reverb_gain=0.2, decay_seconds=2, stereo_width=0.7)
    expected = _unducked_return(tmp_path, dry, profile, rate)

    report = _render_separate_buses(object(), source, output, threading.Event(), profile)

    rendered, rendered_rate = sf.read(output, always_2d=True)
    wet = rendered - dry
    active = slice(round(rate * 0.8), round(rate * 1.35))
    gap = slice(round(rate * 2.2), round(rate * 2.7))
    active_db = 10 * np.log10(np.sum(wet[active] ** 2) / np.sum(expected[active] ** 2))
    assert -3.01 <= active_db < -2.0
    np.testing.assert_allclose(wet[gap], expected[gap], rtol=0.006, atol=2e-8)
    assert rendered.shape == dry.shape and rendered_rate == rate
    assert source.read_bytes() == original
    assert report["vocalDucking"]["buses"] == ["reverb"]
    measured = 10 * np.log10(np.sum(wet**2) / np.sum(dry**2))
    assert report["calibration"]["measuredOutputWetToDryDb"] == pytest.approx(measured, abs=1e-5)
    if channels == 2:
        # Linked attenuation can change only the wet vector, never the dry contribution.
        cross = rendered[:, 0] * expected[:, 1] - rendered[:, 1] * expected[:, 0]
        dry_cross = dry[:, 0] * expected[:, 1] - dry[:, 1] * expected[:, 0]
        np.testing.assert_allclose(cross, dry_cross, atol=2e-9, rtol=0)


@pytest.mark.parametrize("with_ambience", [False, True])
def test_measured_echoes_and_early_stereo_reflections_keep_their_timing_and_level(
    tmp_path, with_ambience
):
    rate = 8000
    dry = _phrases(rate)
    source, output = tmp_path / "voice.wav", tmp_path / "result.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    dry, _ = sf.read(source, always_2d=True)
    shift = round(rate * 0.213)
    profile = SpaceProfile(reverb_gain=0.2 if with_ambience else 0, decay_seconds=2)
    _render_separate_buses(object(), source, output, threading.Event(), profile)
    expected, _ = sf.read(output, always_2d=True)
    expected[shift:] += dry[:-shift] * 0.18
    response = np.zeros(round(rate * 0.04))
    for delay, gain in [(0.012, 0.1), (0.03, 0.06)]:
        response[round(rate * delay)] = gain
    side = fftconvolve(dry.mean(axis=1), response)[: len(dry)]
    expected += np.column_stack((side, -side))
    report = _render_separate_buses(
        object(),
        source,
        output,
        threading.Event(),
        SpaceProfile(echo_taps=((0.213, 0.18),), reverb_gain=profile.reverb_gain, decay_seconds=2),
        side_response=response,
    )
    actual, _ = sf.read(output, always_2d=True)
    np.testing.assert_allclose(actual, expected, atol=2e-8, rtol=0)
    assert report.get("vocalDucking", {}).get("buses", []) == (["reverb"] if with_ambience else [])


def test_diffuse_return_preserves_the_center_and_labels_calibration_before_ducking(tmp_path):
    from backend.recordings.studio_field import DiffuseFieldPlan
    from backend.recordings.studio_space import _SpatialBuses

    rate = 8000
    dry = _phrases(rate, channels=1).repeat(2, axis=1)
    source, output = tmp_path / "voice.wav", tmp_path / "result.wav"
    sf.write(source, dry, rate, subtype="FLOAT")
    response = np.zeros(round(rate * 0.4))
    response[round(rate * 0.08) :] = np.random.default_rng(41).normal(size=round(rate * 0.32))
    response /= np.linalg.norm(response)
    plan = DiffuseFieldPlan(response, 0.05, 0.2)
    report = _SpatialBuses(
        source, output, threading.Event(), {"diffuse-field": SpaceProfile()}, diffuse_field=plan
    ).run()
    actual, _ = sf.read(output, always_2d=True)
    np.testing.assert_allclose(actual.mean(axis=1), dry[:, 0], atol=5e-9, rtol=0)
    assert report["vocalDucking"]["applied"]
    assert report["vocalDucking"]["buses"] == ["diffuse-field"]
    assert report["diffuseField"]["calibrationStage"] == "before-vocal-ducking"
    assert report["diffuseField"]["applied"]


@pytest.mark.parametrize("rate", [8000, 44100, 48000])
def test_wet_ducker_is_level_relative_stereo_linked_and_does_not_modify_the_voice(rate):
    from backend.recordings.studio_ambience import WetReturnDucker

    dry = _phrases(rate)
    original = dry.copy()
    full = WetReturnDucker(rate, 0.04).gains(dry)
    quiet = WetReturnDucker(rate, 0.0004).gains(dry * 0.01)
    np.testing.assert_allclose(full, quiet, atol=2e-14, rtol=0)
    np.testing.assert_array_equal(dry, original)
    assert full.shape == (len(dry),)
    assert np.min(full) >= 10 ** (-3 / 20) and np.max(full) <= 1
    assert np.max(np.abs(np.diff(full))) < 0.003


@pytest.mark.parametrize("rate", [8000, 44100])
def test_wet_ducker_is_independent_of_io_block_sizes_and_preserves_release(rate):
    from backend.recordings.studio_ambience import WetReturnDucker

    dry = _phrases(rate)
    expected = WetReturnDucker(rate, 0.04).gains(dry)
    ducker = WetReturnDucker(rate, 0.04)
    boundaries = sorted({0, 1, 53, 1024, 32768, 32769, len(dry)})
    actual = np.concatenate([ducker.gains(dry[a:b]) for a, b in zip(boundaries, boundaries[1:])])
    np.testing.assert_allclose(actual, expected, atol=2e-14, rtol=0)
    recovery = actual[round(rate * 1.51) : round(rate * 2.5)]
    assert np.all(np.diff(recovery) >= 0)
    assert recovery[-1] > 0.999
    assert ducker.gains(np.empty((0, 2))).size == 0
    np.testing.assert_array_equal(WetReturnDucker(rate, 0).gains(dry), 1)


def test_ambience_mix_still_checks_cancellation_and_cleans_wet_files(tmp_path, monkeypatch):
    from backend.domain_errors import DomainError
    from backend.recordings.studio_ambience import WetReturnDucker

    rate = 16000
    source, output = tmp_path / "voice.wav", tmp_path / "result.wav"
    sf.write(source, _phrases(rate), rate, subtype="FLOAT")
    original = source.read_bytes()
    cancel = threading.Event()
    gains = WetReturnDucker.gains

    def cancel_after_first_block(self, block):
        result = gains(self, block)
        cancel.set()
        return result

    monkeypatch.setattr(WetReturnDucker, "gains", cancel_after_first_block)
    with pytest.raises(DomainError, match="cancelled"):
        _render_separate_buses(
            object(), source, output, cancel, SpaceProfile(reverb_gain=0.2, decay_seconds=1)
        )
    assert source.read_bytes() == original
    assert not list(tmp_path.glob("result.*.wet.wav"))
    assert not list(tmp_path.glob("result.*.ir.wav"))
