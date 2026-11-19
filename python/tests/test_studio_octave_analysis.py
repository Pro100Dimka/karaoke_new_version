"""Octave-family evidence must not mistake an ordinary overtone for another voice."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.signal import fftconvolve

from backend.ai.domain import PitchPoint
from backend.domain_errors import DomainError
from backend.recordings.studio_octave_analysis import analyze_octaves


def reference_fixture(
    rate, *, semitones=-12, layer=True, stereo=True, exact=False, kind="clean", lead_multiplier=1
):
    time = np.arange(rate * 7) / rate
    frequency = np.where(time < 2, 180.0, np.where(time < 4, 220.0, 196.0))
    frequency *= lead_multiplier
    if kind == "vibrato":
        frequency *= 1 + 0.02 * np.sin(2 * np.pi * 5 * time + 0.7)
    phase = 2 * np.pi * np.cumsum(frequency) / rate
    main = sum(0.06 / h**1.5 * np.sin(h * phase + 0.13 * h) for h in range(1, 20))
    if kind == "even":
        main += sum(0.15 / h * np.sin(2 * h * phase) for h in range(1, 10))
    envelope = np.clip((time - 2.2) / 0.04, 0, 1) * np.clip((5.4 - time) / 0.04, 0, 1)
    relative = 1.0 if exact else 1.012 + 0.004 * np.sin(2 * np.pi * 1.3 * time + 0.4)
    shifted_phase = 2 * np.pi * np.cumsum(frequency * 2 ** (semitones / 12) * relative) / rate
    extra = sum(0.025 / h * np.sin(h * shifted_phase + 0.31 * h) for h in range(1, 14))
    extra *= envelope if layer else 0
    if stereo:
        voice = np.column_stack((main + 0.35 * extra, main + extra))
    else:
        voice = main + extra
    points = tuple(
        PitchPoint(float(t), float(frequency[round(t * rate)]), 0.99, True)
        for t in np.arange(0, 6.99, 0.01)
    )
    return time, voice, points


@pytest.mark.parametrize("rate", [44100, 48000])
@pytest.mark.parametrize("semitones", [-12, 12])
@pytest.mark.parametrize("stereo", [False, True])
def test_independent_octave_family_is_detected_in_its_section(tmp_path, rate, semitones, stereo):
    _, voice, points = reference_fixture(rate, semitones=semitones, stereo=stereo)
    source = tmp_path / "reference.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    before = source.read_bytes()

    regions, report = analyze_octaves(source, threading.Event(), reference_pitch=points)

    found = [region for region in regions if region.semitones == semitones]
    assert found
    assert sum(max(0, min(region.end, 3.8) - max(region.start, 2.4)) for region in found) > 0.5
    assert all(2.0 <= region.start < region.end <= 5.6 for region in found)
    assert all(region.kind == "octave" and 0 < region.gain <= 0.35 for region in found)
    assert report["supportedFrames"] > 0
    assert source.read_bytes() == before


@pytest.mark.parametrize("semitones", [-12, 12])
def test_exact_spatial_octave_without_independent_motion_is_ambiguous(tmp_path, semitones):
    rate = 48000
    _, voice, points = reference_fixture(rate, exact=True, semitones=semitones)
    source = tmp_path / "reference.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)
    assert regions == []


@pytest.mark.parametrize("kind", ["clean", "even", "vibrato"])
def test_single_voice_harmonics_do_not_create_octave_regions(tmp_path, kind):
    rate = 48000
    _, voice, points = reference_fixture(rate, layer=False, kind=kind, stereo=False)
    source = tmp_path / "single.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)
    assert regions == []


def test_even_rich_mono_with_an_octave_wrong_guide_is_ambiguous(tmp_path):
    rate = 48000
    _, voice, points = reference_fixture(rate, layer=False, kind="even", stereo=False)
    points = tuple(PitchPoint(p.time, p.frequency * 2, p.confidence, True) for p in points)
    source = tmp_path / "even.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)
    assert regions == []


def test_a_previous_octave_notes_reverb_is_not_a_new_layer(tmp_path):
    rate = 48000
    time = np.arange(rate * 5) / rate
    frequency = np.where(time < 2, 170.0, 340.0)
    phase = 2 * np.pi * np.cumsum(frequency) / rate
    dry = sum(0.05 / h * np.sin(h * phase) for h in range(1, 12))
    impulse = np.random.default_rng(40).normal(size=rate) * np.exp(-np.arange(rate) / (rate * 0.15))
    impulse *= 0.05 / np.sqrt(np.sum(impulse**2))
    wet = fftconvolve(dry, np.r_[np.zeros(round(rate * 0.07)), impulse])[: len(dry)]
    voice = np.column_stack((dry + wet, dry - 0.7 * wet))
    source = tmp_path / "reverb.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    points = tuple(
        PitchPoint(float(t), 170 if t < 2 else 340, 1, True) for t in np.arange(0, 4.99, 0.01)
    )
    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)
    assert regions == []


def test_missing_or_uncertain_guide_does_not_guess_an_octave(tmp_path):
    rate = 44100
    _, voice, points = reference_fixture(rate)
    source = tmp_path / "reference.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    for guide in ((), tuple(PitchPoint(p.time, p.frequency, 0.2, True) for p in points)):
        regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=guide)
        assert regions == []


@pytest.mark.parametrize("stereo", [False, True])
def test_detuned_unison_double_does_not_invent_an_octave(tmp_path, stereo):
    rate = 48000
    _, voice, points = reference_fixture(rate, semitones=0, stereo=stereo)
    source = tmp_path / "unison-double.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)

    assert regions == []


@pytest.mark.parametrize("guide_multiple", [1, 2])
def test_stereo_reflection_is_not_a_separate_octave_voice(tmp_path, guide_multiple):
    rate = 48000
    time = np.arange(rate * 4) / rate
    dry = sum(0.06 / h**1.2 * np.sin(2 * np.pi * 200 * h * time + 0.13 * h) for h in range(1, 18))
    delay = round(rate * 0.0025)
    reflection = np.r_[np.zeros(delay), dry[:-delay]]
    voice = np.column_stack((dry, dry + 0.5 * reflection))
    source = tmp_path / "stereo-reflection.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    points = tuple(
        PitchPoint(t, 200 * guide_multiple, 0.99, True) for t in np.arange(0, 3.99, 0.01)
    )

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)

    assert regions == []


def test_reference_guide_gaps_are_not_bridged_or_extended_into(tmp_path):
    rate = 44100
    _, voice, points = reference_fixture(rate)
    guide = tuple(p for p in points if not 2.7 < p.time < 3.3)
    source = tmp_path / "sparse-guide.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=guide)

    assert regions
    assert all(region.end <= 2.725 or region.start >= 3.275 for region in regions)


@pytest.mark.parametrize("duration", [1, 7])
def test_analysis_reads_bounded_batches_and_checks_cancellation(tmp_path, monkeypatch, duration):
    rate = 48000
    _, voice, points = reference_fixture(rate)
    source = tmp_path / "cancel.wav"
    sf.write(source, voice[: duration * rate], rate, subtype="FLOAT")
    before = source.read_bytes()
    cancel = threading.Event()
    original = sf.SoundFile.read
    reads = []

    def read_and_cancel(audio, frames=-1, *args, **kwargs):
        samples = original(audio, frames, *args, **kwargs)
        reads.append(frames)
        cancel.set()
        return samples

    monkeypatch.setattr(sf.SoundFile, "read", read_and_cancel)
    with pytest.raises(DomainError, match="cancel"):
        analyze_octaves(source, cancel, reference_pitch=points)
    assert len(reads) == 1 and 0 < max(reads) < rate * 3
    assert source.read_bytes() == before


@pytest.mark.parametrize("anchor", [False, True])
def test_a_weak_lower_family_can_continue_only_from_a_strong_anchor(tmp_path, anchor):
    rate = 48000
    time = np.arange(rate * 6) / rate
    frequency = 240 * (1 + 0.005 * np.sin(2 * np.pi * 0.7 * time))
    main_phase = 2 * np.pi * np.cumsum(frequency) / rate
    lower_phase = (
        2
        * np.pi
        * np.cumsum(frequency * 0.5 * (1.012 + 0.004 * np.sin(2 * np.pi * 1.3 * time)))
        / rate
    )
    dry = sum(0.06 / h**1.5 * np.sin(h * main_phase) for h in range(1, 14))
    envelope = np.clip((time - 1) / 0.04, 0, 1) * np.clip((5 - time) / 0.04, 0, 1)
    strong = np.clip((time - 2) / 0.04, 0, 1) * np.clip((2.8 - time) / 0.04, 0, 1) * anchor
    low = sum(0.025 / h * np.sin(h * lower_phase) for h in (1, 3)) * envelope
    low += sum(0.025 / h * np.sin(h * lower_phase) for h in (5, 7, 9)) * strong
    source = tmp_path / "lower-continuation.wav"
    sf.write(source, np.column_stack((dry + 0.35 * low, dry + low)), rate, subtype="FLOAT")
    points = tuple(
        PitchPoint(t, frequency[round(t * rate)], 0.99, True) for t in np.arange(0, 5.99, 0.01)
    )

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)

    if not anchor:
        assert regions == []
    else:
        lower = [region for region in regions if region.semitones == -12]
        assert sum(max(0, min(region.end, 4.8) - max(region.start, 3)) for region in lower) >= 1.5
        assert all(0.9 <= region.start < region.end <= 5.1 for region in lower)


def high_unison_fixture(rate, f0, variation):
    time = np.arange(rate * 2) / rate
    frequency = (
        f0 * (1 + 0.01 * np.sin(2 * np.pi * 5 * time + 0.7))
        if variation == "vibrato"
        else np.full(len(time), f0)
    )
    phase = 2 * np.pi * np.cumsum(frequency) / rate
    other_phase = (
        2
        * np.pi
        * np.cumsum(frequency * (1.012 + 0.004 * np.sin(2 * np.pi * 1.3 * time + 0.4)))
        / rate
    )
    dry, extra = np.zeros(len(time)), np.zeros(len(time))
    for h in range(1, 15):
        body = (
            0.015
            + 0.045 * np.exp(-(((h * f0 - 600) / 250) ** 2))
            + 0.015 * np.exp(-(((h * f0 - 1600) / 500) ** 2))
        ) / h**0.5
        double = (
            0.015
            + 0.03 * np.exp(-(((h * f0 - 900) / 400) ** 2))
            + 0.025 * np.exp(-(((h * f0 - 2400) / 500) ** 2))
        ) / h**0.5
        dry += (body if variation == "formants" else 0.06 / h**1.5) * np.sin(h * phase + 0.13 * h)
        extra += (double if variation == "formants" else 0.06 / h) * np.sin(
            h * other_phase + 0.31 * h
        )
    points = tuple(
        PitchPoint(t, frequency[round(t * rate)], 0.99, True) for t in np.arange(0, 1.99, 0.01)
    )
    return np.column_stack((dry + 0.35 * 0.8 * extra, dry + 0.8 * extra)), points


@pytest.mark.parametrize("variation", ["formants", "vibrato"])
def test_high_unison_doubles_retain_enough_odd_harmonics_to_disambiguate(tmp_path, variation):
    rate = 48000
    voice, points = high_unison_fixture(rate, 440, variation)
    source = tmp_path / "bright-unison.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)

    assert regions == []


def test_true_high_upper_octave_remains_identifiable(tmp_path):
    rate = 48000
    _, voice, points = reference_fixture(rate, semitones=12, lead_multiplier=2)
    source = tmp_path / "high-octave.wav"
    sf.write(source, voice, rate, subtype="FLOAT")

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)

    assert sum(region.end - region.start for region in regions if region.semitones == 12) > 1


def test_input_gain_does_not_change_the_detected_regions(tmp_path):
    rate = 44100
    _, voice, points = reference_fixture(rate)
    plans = []
    for gain in (0.01, 1.0, 10.0):
        source = tmp_path / f"level-{gain}.wav"
        sf.write(source, voice * gain, rate, subtype="FLOAT")
        regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)
        plans.append(np.array([(r.start, r.end, r.semitones, r.gain) for r in regions]))
    assert len(plans[0]) > 0
    np.testing.assert_allclose(plans[0], plans[1], rtol=1e-5, atol=1e-5)
    np.testing.assert_allclose(plans[1], plans[2], rtol=1e-5, atol=1e-5)


def test_broadband_noise_with_a_confident_guide_is_not_an_octave(tmp_path):
    rate = 48000
    voice = np.random.default_rng(7).normal(0, 0.03, (rate * 3, 2))
    source = tmp_path / "noise.wav"
    sf.write(source, voice, rate, subtype="FLOAT")
    points = tuple(PitchPoint(t, 220, 0.99, True) for t in np.arange(0, 2.99, 0.01))

    regions, _ = analyze_octaves(source, threading.Event(), reference_pitch=points)

    assert regions == []
