import subprocess
import threading
from pathlib import Path

import numpy as np
import soundfile as sf
import pytest

from backend.recordings.studio_space import SpaceProfile, _render_separate_buses
from scipy.signal import fftconvolve


@pytest.mark.parametrize("delay", [0.1, 0.2])
def test_diffuse_field_adds_delayed_space_without_changing_the_center(tmp_path, monkeypatch, delay):
    import backend.recordings.studio_space as module

    rate = 8000
    rng = np.random.default_rng(91)
    time = np.arange(rate * 18) / rate
    envelope = np.where((time % 1.5) < 0.65, 1.0, 0.05)
    mono = rng.normal(0, 0.04, len(time)) * envelope
    impulse = np.zeros(round(rate * 0.4))
    start = round(delay * rate)
    impulse[start : start + rate // 10] = rng.normal(size=rate // 10)
    impulse *= 0.28 / np.linalg.norm(impulse)
    side = fftconvolve(mono, impulse)[: len(mono)]
    dry = np.column_stack((mono, mono))
    reference = np.column_stack((mono + side, mono - side))
    source, ref, before, after = [tmp_path / f"{n}.wav" for n in ["dry", "ref", "before", "after"]]
    sf.write(source, dry, rate, subtype="FLOAT")
    sf.write(ref, reference, rate, subtype="FLOAT")
    with monkeypatch.context() as context:
        context.setattr(module, "plan_diffuse_field", lambda *a: None, raising=False)
        module.apply_reference_space(object(), ref, source, source, before, threading.Event())
    report = module.apply_reference_space(object(), ref, source, source, after, threading.Event())
    old, _ = sf.read(before, always_2d=True)
    actual, sr = sf.read(after, always_2d=True)
    assert sr == rate and actual.shape == dry.shape
    np.testing.assert_allclose(actual.mean(axis=1), old.mean(axis=1), atol=1e-7)

    def side_power(samples):
        return np.mean(((samples[:, 0] - samples[:, 1]) / 2) ** 2)

    assert side_power(actual) > max(side_power(old) * 4, np.mean(mono**2) * 0.01)
    assert report["diffuseField"]["applied"]
    assert report["diffuseField"]["heldOutImprovement"] >= 0.05
    repeated = tmp_path / "repeated.wav"
    report = module.apply_reference_space(object(), ref, ref, ref, repeated, threading.Event())
    assert not report["diffuseField"]["applied"]
    np.testing.assert_allclose(sf.read(repeated)[0], reference, atol=1e-7)


def test_panned_direct_voice_does_not_create_a_diffuse_field(tmp_path):
    from backend.recordings.studio_space import apply_reference_space

    rate = 8000
    rng = np.random.default_rng(93)
    time = np.arange(rate * 12) / rate
    mono = rng.normal(0, 0.03, len(time)) * np.where((time % 1.5) < 0.6, 1.0, 0.1)
    source, ref, target = [tmp_path / f"{n}.wav" for n in ["voice", "ref", "out"]]
    sf.write(source, np.column_stack((mono, mono)), rate, subtype="FLOAT")
    sf.write(ref, np.column_stack((1.2 * mono, 0.8 * mono)), rate, subtype="FLOAT")
    report = apply_reference_space(object(), ref, source, source, target, threading.Event())
    assert not report["diffuseField"]["applied"]
    np.testing.assert_array_equal(sf.read(target)[0], sf.read(source)[0])


@pytest.mark.parametrize("already_present", [False, True])
def test_measured_short_stereo_reflections_preserve_the_direct_voice(
    tmp_path, monkeypatch, already_present
):
    import backend.recordings.studio_space as module

    rate = 16000
    mono = np.random.default_rng(72).normal(0, 0.03, rate * 16)
    side = np.zeros_like(mono)
    for delay, gain in [(0.012, 0.24), (0.03, 0.14)]:
        shift = round(rate * delay)
        side[shift:] += mono[:-shift] * gain
    dry = np.column_stack([mono, mono])
    reference = np.column_stack([mono + side, mono - side])
    ref, recorded, voice, output = [tmp_path / f"{n}.wav" for n in ["ref", "raw", "voice", "out"]]
    for path, data in [
        (ref, reference),
        (recorded, reference if already_present else dry),
        (voice, reference if already_present else dry),
    ]:
        sf.write(path, data, rate, subtype="FLOAT")
    monkeypatch.setattr(module, "analyze_space", lambda *a: SpaceProfile())
    report = module.apply_reference_space(object(), ref, recorded, voice, output, threading.Event())
    actual, sr = sf.read(output, always_2d=True)
    assert sr == rate and actual.shape == dry.shape
    np.testing.assert_allclose(actual.mean(axis=1), mono, atol=1e-8)
    if already_present:
        np.testing.assert_allclose(actual, reference, atol=1e-8)
        assert not report["stereoField"]["applied"]
    else:
        observed = (actual[:, 0] - actual[:, 1]) / 2
        assert np.sqrt(np.mean((observed - side) ** 2) / np.mean(side**2)) < 0.15
        assert report["stereoField"]["applied"]


def test_unrelated_stereo_energy_does_not_create_a_spatial_return(tmp_path, monkeypatch):
    import backend.recordings.studio_space as module

    rng = np.random.default_rng(81)
    source, ref, output = [tmp_path / f"{n}.wav" for n in ["source", "ref", "out"]]
    dry = rng.normal(0, 0.03, (16000 * 12, 1)).repeat(2, axis=1)
    sf.write(source, dry, 16000, subtype="FLOAT")
    sf.write(ref, dry + rng.normal(0, 0.02, dry.shape), 16000, subtype="FLOAT")
    monkeypatch.setattr(module, "analyze_space", lambda *a: SpaceProfile())
    report = module.apply_reference_space(object(), ref, source, source, output, threading.Event())
    np.testing.assert_array_equal(sf.read(output)[0], sf.read(source)[0])
    assert not report["stereoField"]["applied"]


class Renderer:
    def _mix(self, a, b, graph, output, cancel):
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-i",
                str(a),
                "-i",
                str(b),
                "-filter_complex",
                graph,
                "-map",
                "[out]",
                *output,
            ],
            check=True,
            timeout=25,
        )


def test_separate_buses_preserve_frames_and_apply_effects(tmp_path: Path) -> None:
    rate = 16000
    time = np.arange(rate * 2) / rate
    wave = 0.09 * np.sin(2 * np.pi * 220 * time)
    audio = np.column_stack([wave, wave]).astype("float32")
    audio[: rate // 5] = 0
    sf.write(tmp_path / "dry.wav", audio, rate, subtype="FLOAT")
    profile = SpaceProfile(
        delay_seconds=0.11,
        delay_gain=0.18,
        decay_seconds=0.55,
        reverb_gain=0.2,
        stereo_width=0.5,
        effect_type="slapback",
    )
    _render_separate_buses(
        Renderer(),
        tmp_path / "dry.wav",
        tmp_path / "out.wav",
        threading.Event(),
        profile,
    )
    output, output_rate = sf.read(tmp_path / "out.wav", always_2d=True)
    assert output_rate == rate
    assert output.shape == audio.shape
    assert np.isfinite(output).all()
    assert np.max(np.abs(output - audio)) > 1e-5
