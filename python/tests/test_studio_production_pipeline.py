"""The shipped mix entry point must carry local production context into the audio."""

import hashlib
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

from backend.infrastructure.process_runner import ProcessRunner
from backend.recordings import studio_adaptive_mix
from backend.recordings.studio_master import FfmpegStudioMasterRenderer
from backend.recordings.studio_sources import IDENTITY_TIMELINE, prepare_sources


RATE = 8000


def _production_stems(root):
    rng = np.random.default_rng(571)
    count = RATE * 36
    envelope = np.repeat(rng.uniform(0.25, 1, 144), RATE // 4)
    envelope = gaussian_filter1d(envelope, RATE * 0.025)
    direct = (
        sosfilt(
            butter(2, (500, 3000), fs=RATE, btype="bandpass", output="sos"),
            rng.normal(0, 0.06, count),
        )
        * envelope
    )
    wet = []
    for _ in range(2):
        impulse = rng.normal(size=round(RATE * 0.6))
        impulse *= np.exp(-6.907755 * np.arange(len(impulse)) / (RATE * 0.6))
        impulse[: round(RATE * 0.03)] = 0
        impulse /= np.linalg.norm(impulse)
        wet.append(fftconvolve(direct, impulse)[:count])
    amounts = np.repeat([0.1, 0.6, 0.1], count // 3)
    dry = np.column_stack((direct, direct))
    reference = dry + np.column_stack(wet) * amounts[:, None]
    time = np.arange(count) / RATE
    music = 0.04 * np.sin(2 * np.pi * 150 * time)
    paths = [root / f"{name}.wav" for name in ("voice", "backing", "reference")]
    for path, audio in zip(paths, (dry, np.column_stack((music, music)), reference), strict=True):
        sf.write(path, audio, RATE, subtype="FLOAT")
    return paths


def _capture_mix(monkeypatch):
    captured = {}
    gain = studio_adaptive_mix._write_gain_envelope
    sends = studio_adaptive_mix.render_sends

    def capture_gain(source, target, *args, **kwargs):
        gain(source, target, *args, **kwargs)
        captured["dry"] = sf.read(target, always_2d=True)[0]

    def capture_sends(source, backing, target, *args, **kwargs):
        report = sends(source, backing, target, *args, **kwargs)
        captured["spatial"] = sf.read(target, always_2d=True)[0]
        return report

    monkeypatch.setattr(studio_adaptive_mix, "_write_gain_envelope", capture_gain)
    monkeypatch.setattr(studio_adaptive_mix, "render_sends", capture_sends)
    return captured


def _wet_ratio(captured, start, end):
    dry = captured["dry"][start * RATE : end * RATE].mean(axis=1)
    wet = (captured["spatial"] - captured["dry"])[start * RATE : end * RATE].mean(axis=1)
    return 10 * np.log10(max(float(np.mean(wet**2)), 1e-30) / np.mean(dry**2))


def test_actual_mix_uses_production_sections_and_audible_mono_returns(tmp_path, monkeypatch):
    voice, backing, reference = _production_stems(tmp_path)
    paths = (voice, backing, reference)
    before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]
    captured = _capture_mix(monkeypatch)
    target = tmp_path / "master.wav"
    report = studio_adaptive_mix.mix_and_master(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        voice,
        backing,
        target,
        threading.Event(),
        reference_vocal=reference,
        reference_backing=backing,
    )
    first, middle, last = [_wet_ratio(captured, a, b) for a, b in ((2, 10), (15, 21), (27, 33))]
    assert middle > -25, "A stereo-only field is not a mono-compatible room return"
    assert middle > first + 6 and middle > last + 6
    assert abs(first - last) < 6
    arrangement = report["arrangement"]
    assert len(arrangement["sections"]) >= 3
    assert arrangement["timebase"] == "performed-timeline-seconds-from-zero"
    assert arrangement["frames"] == RATE * 36
    assert report["space"]["dryPathUnity"] is True
    assert report["balance"]["gainApplications"] == 1
    assert report["delivery"]["truePeakDbtp"] <= -1
    assert sf.info(target).frames == RATE * 36
    assert before == [hashlib.sha256(path.read_bytes()).hexdigest() for path in paths]


def test_no_reference_preserves_the_vocal_without_inventing_section_effects(tmp_path, monkeypatch):
    voice, backing, _ = _production_stems(tmp_path)
    captured = _capture_mix(monkeypatch)
    report = studio_adaptive_mix.mix_and_master(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        voice,
        backing,
        tmp_path / "master.wav",
        threading.Event(),
    )
    np.testing.assert_array_equal(captured["spatial"], captured["dry"])
    np.testing.assert_array_equal(captured["dry"], sf.read(voice, always_2d=True)[0])
    assert report["arrangement"]["referenceAvailable"] is False
    assert report["balance"]["referenceUsed"] is False
    assert report["space"]["applied"] is False


@pytest.mark.parametrize("offset,expected", [(0.5, ((0.0, 3.5),)), (-0.5, ((0.5, 4.0),))])
def test_reference_alignment_padding_is_unknown_to_section_analysis(
    tmp_path, monkeypatch, offset, expected
):
    source = tmp_path / "source.wav"
    time = np.arange(RATE * 4) / RATE
    sf.write(source, 0.05 * np.sin(2 * np.pi * 220 * time), RATE, subtype="FLOAT")
    monkeypatch.setattr(
        FfmpegStudioMasterRenderer, "_reference_offset", lambda *args: (offset, 1.0)
    )
    prepared = prepare_sources(
        FfmpegStudioMasterRenderer(ProcessRunner()),
        source,
        source,
        source,
        source,
        source,
        tmp_path,
        threading.Event(),
        IDENTITY_TIMELINE,
        exact_stems=True,
    )
    assert prepared.reference_intervals == expected
