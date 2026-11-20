"""Waveform evidence distinguishes local repeats and dry stereo placement."""

from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

from backend.recordings.studio_adaptive_space import render_sends
from backend.recordings.studio_coherent_echo import echo_buses, plan_coherent_echoes


RATE = 8000


def _reference(seconds=27, echo_start=24, delay_seconds=0.32, gains=(0.6, 0.2)):
    rng = np.random.default_rng(7419)
    count = RATE * seconds
    envelope = gaussian_filter1d(
        np.repeat(rng.uniform(0.3, 1, seconds * 4), RATE // 4), RATE * 0.025
    )
    voice = (
        sosfilt(
            butter(2, (500, 3000), fs=RATE, btype="bandpass", output="sos"),
            rng.normal(0, 0.06, count),
        )
        * envelope
    )
    voice[round((seconds - 0.7) * RATE) :] = 0
    room_input = voice.copy()
    room_input[echo_start * RATE :] = 0
    returns = []
    for _ in range(2):
        impulse = rng.normal(size=round(RATE * 0.65))
        impulse *= np.exp(-6.907755 * np.arange(len(impulse)) / (RATE * 0.65))
        impulse[: round(RATE * 0.03)] = 0
        impulse /= np.linalg.norm(impulse)
        returns.append(fftconvolve(room_input, impulse)[:count] * 0.4)
    echo_input = voice.copy()
    echo_input[: echo_start * RATE] = 0
    delay = round(delay_seconds * RATE)
    delayed = np.r_[np.zeros(delay), echo_input[:-delay]]
    echo = np.column_stack((delayed * gains[0], delayed * gains[1]))
    dry = np.column_stack((voice, voice))
    return dry, dry + np.column_stack(returns) + echo, echo


def _arrangement(count, boundaries):
    times = (np.arange(round(count / RATE * 4)) + 0.5) / 4
    return SimpleNamespace(
        frames=count,
        rate=RATE,
        duration_seconds=count / RATE,
        times=times,
        reference_valid=np.ones(len(times), dtype=bool),
        sections=tuple(
            SimpleNamespace(start_seconds=a, end_seconds=b, confidence=1.0, repeat_group=None)
            for a, b in zip(boundaries[:-1], boundaries[1:])
        ),
    )


def _voiced_phrase(seconds=10, stationary=False, gains=(0.6, 0.2), delay=0.32):
    time = np.arange(seconds * RATE) / RATE
    frequency = (
        np.full(len(time), 200.0)
        if stationary
        else (180 + 10 * np.sin(2 * np.pi * 0.08 * time) + 0.5 * np.sin(2 * np.pi * 5 * time))
    )
    phase = 2 * np.pi * np.cumsum(frequency) / RATE
    vowel = np.zeros(len(time)) if stationary else np.sin(2 * np.pi * 0.1 * time)
    voice = np.zeros(len(time))
    for harmonic in range(1, 17):
        hz = harmonic * frequency
        formants = (
            np.exp(-0.5 * ((hz - (500 + 100 * vowel)) / 100) ** 2)
            + 0.7 * np.exp(-0.5 * ((hz - (1500 + 300 * vowel)) / 180) ** 2)
            + 0.4 * np.exp(-0.5 * ((hz - 2800) / 200) ** 2)
        )
        voice += np.sin(harmonic * phase) * (0.08 + formants) / harmonic
    voice *= 0.04 / np.sqrt(np.mean(voice**2))
    voice *= np.minimum(time / 0.2, 1)
    samples = round(delay * RATE)
    copied = np.r_[np.zeros(samples), voice[:-samples]]
    echo = np.column_stack((copied * gains[0], copied * gains[1]))
    dry = np.column_stack((voice, voice))
    return dry, dry + echo, echo


def _render(root, dry, reference, boundaries):
    paths = {name: root / f"{name}.wav" for name in ("dry", "reference", "backing", "result")}
    for name, samples in (("dry", dry), ("reference", reference), ("backing", dry * 0.5)):
        sf.write(paths[name], samples, RATE, subtype="FLOAT")
    original = {name: path.read_bytes() for name, path in paths.items() if name != "result"}
    report = render_sends(
        paths["dry"],
        paths["backing"],
        paths["result"],
        threading.Event(),
        reference=paths["reference"],
        arrangement=_arrangement(len(dry), boundaries),
    )
    assert original == {name: paths[name].read_bytes() for name in original}
    output, rate = sf.read(paths["result"], always_2d=True)
    assert rate == RATE and output.shape == dry.shape
    return output, sf.read(paths["dry"], always_2d=True)[0], report


@pytest.mark.parametrize(
    "delay,gains", [(0.12, (0.4, 0.1)), (0.32, (0.6, 0.2)), (0.48, (0.2, 0.55))]
)
def test_short_coherent_echo_is_not_replaced_with_global_diffuse_room(tmp_path, delay, gains):
    dry, reference, known_echo = _reference(delay_seconds=delay, gains=gains)
    output, stored, report = _render(tmp_path, dry, reference, (0, 24, 27))
    section = slice(round(24.7 * RATE), None)
    actual = (output - stored)[section].mean(axis=1)
    expected = known_echo[section].mean(axis=1)
    assert np.corrcoef(actual, expected)[0, 1] > 0.8
    assert np.sqrt(np.mean(actual**2) / np.mean(expected**2)) == pytest.approx(1, rel=0.1)
    assert len(report["coherentEchoRegions"]) == 1
    assert report["coherentEchoRegions"][0]["delaySeconds"] == pytest.approx(delay, abs=0.002)
    assert all(region["endSeconds"] <= 24 for region in report["ambienceRegions"])


def test_dry_panning_does_not_count_as_existing_ambience(tmp_path):
    dry, reference, _ = _reference(seconds=18, echo_start=18)
    output, stored, report = _render(tmp_path, dry * (1.5, 0.5), reference, (0, 18))
    assert not np.array_equal(output, stored)
    wet = (output - stored).mean(axis=1)
    ratio = 10 * np.log10(np.mean(wet**2) / np.mean(stored.mean(axis=1) ** 2))
    assert -25 < ratio < -5
    assert report["dryPathUnity"]


def test_existing_regional_echo_is_not_added_twice(tmp_path):
    _, reference, _ = _reference()
    output, stored, report = _render(tmp_path, reference, reference, (0, 24, 27))
    np.testing.assert_array_equal(output, stored)
    assert report["coherentEchoRegions"][0]["decision"] == "existing-coherent-copy-preserved"


@pytest.mark.parametrize("existing_delay", [0.12, 0.32])
def test_partial_existing_echo_is_preserved_without_creating_a_second_repeat(
    tmp_path, existing_delay
):
    _, reference, _ = _reference()
    _, existing, _ = _reference(delay_seconds=existing_delay, gains=(0.3, 0.1))
    output, stored, report = _render(tmp_path, existing, reference, (0, 24, 27))
    np.testing.assert_array_equal(output, stored)
    copy = report["coherentEchoRegions"][0]
    assert copy["decision"] == "existing-coherent-copy-preserved"
    assert copy["targetCopyApplied"] is False
    assert copy["existingDelaySeconds"] == pytest.approx(existing_delay, abs=0.002)


def test_coherent_echo_tail_crosses_the_next_section_boundary(tmp_path):
    dry, reference, known_echo = _reference()
    output, stored, report = _render(tmp_path, dry, reference, (0, 24, 26.5, 27))
    after = slice(round(26.5 * RATE), round(26.6 * RATE))
    actual, expected = (output - stored)[after], known_echo[after]
    assert np.sqrt(np.mean(actual**2)) > 1e-4
    assert np.corrcoef(actual.ravel(), expected.ravel())[0, 1] > 0.99
    assert report["coherentEchoRegions"][0]["endSeconds"] == 26.5


@pytest.mark.parametrize("kind", ["pan", "unrelated", "opposite-phase", "vibrato"])
def test_short_non_echo_region_does_not_acquire_a_coherent_copy(tmp_path, kind):
    dry, reference, _ = _reference()
    start = 24 * RATE
    if kind == "pan":
        reference[start:] = dry[start:] * (1.5, 0.5)
    elif kind == "unrelated":
        reference[start:] = dry[start:] + np.random.default_rng(92).normal(
            0, 0.01, dry[start:].shape
        )
    elif kind == "opposite-phase":
        reference[start:] = dry[start:] * (1, -1)
    else:
        time = np.arange(len(dry) - start) / RATE
        phase = 2 * np.pi * (175 * time + 0.5 * np.sin(2 * np.pi * 5 * time))
        harmonics = np.array([np.sin(phase * n) for n in range(1, 9)])
        reference[start:, 0] = np.arange(1, 9) ** -1.0 @ harmonics * 0.04
        reference[start:, 1] = np.arange(1, 9) ** -0.5 @ harmonics * 0.025
    _, _, report = _render(tmp_path, dry, reference, (0, 24, 27))
    assert not report["coherentEchoRegions"]


def test_coherent_echo_does_not_clip_float_headroom(tmp_path):
    dry, reference, known_echo = _reference()
    output, stored, _ = _render(tmp_path, dry * 64, reference, (0, 24, 27))
    section = slice(round(24.7 * RATE), None)
    actual = (output - stored)[section].mean(axis=1)
    expected = known_echo[section].mean(axis=1) * 64
    assert np.corrcoef(actual, expected)[0, 1] > 0.8
    assert np.sqrt(np.mean(actual**2) / np.mean(expected**2)) == pytest.approx(1, rel=0.1)
    assert np.max(abs(output)) > 1


def test_direct_mono_input_safely_skips_stereo_copy_inference(tmp_path):
    dry, reference, _ = _reference()
    output, stored, report = _render(tmp_path, dry[:, :1], reference, (0, 24, 27))
    np.testing.assert_array_equal(output, stored)
    assert not report["coherentEchoRegions"]


def test_coherent_copy_evidence_reads_bounded_local_contexts(tmp_path, monkeypatch):
    dry, reference, known_echo = _reference(seconds=30, echo_start=0)
    voice_path, reference_path = tmp_path / "voice.wav", tmp_path / "reference.wav"
    sf.write(voice_path, dry, RATE, subtype="FLOAT")
    sf.write(reference_path, reference, RATE, subtype="FLOAT")
    read = sf.SoundFile.read
    counts = []

    def observe(source, frames=-1, *args, **kwargs):
        if str(source.name) == str(reference_path):
            counts.append(frames)
        return read(source, frames, *args, **kwargs)

    monkeypatch.setattr(sf.SoundFile, "read", observe)
    result = plan_coherent_echoes(
        voice_path, reference_path, _arrangement(len(dry), (0, 30)), threading.Event()
    )
    assert result
    assert max(counts) <= 12 * RATE
    assert min(counts) > 0
    assert result[0].start == 0 and result[-1].end == 30
    buses, _ = echo_buses(voice_path, tmp_path, result, threading.Event())
    assert len(buses) == 1
    wet, rate = sf.read(buses[0][1], always_2d=True)
    assert rate == RATE and wet.shape == dry.shape
    # Adjacent evidence contexts do not double the return at their crossfades.
    np.testing.assert_allclose(wet[RATE : 29 * RATE], known_echo[RATE : 29 * RATE], atol=1e-5)


def test_changing_voiced_legato_can_identify_a_unique_coherent_echo(tmp_path):
    dry, reference, known_echo = _voiced_phrase()
    output, stored, report = _render(tmp_path, dry, reference, (0, 10))
    assert report["coherentEchoRegions"]
    actual = (output - stored)[RATE : 9 * RATE]
    expected = known_echo[RATE : 9 * RATE]
    assert np.corrcoef(actual.ravel(), expected.ravel())[0, 1] > 0.99
    assert np.sqrt(np.mean(actual**2) / np.mean(expected**2)) == pytest.approx(1, rel=0.1)


@pytest.mark.parametrize("gains", [(0.6, 0.2), (0.2, 0.55)])
def test_stationary_harmonic_echo_remains_ambiguous(tmp_path, gains):
    dry, reference, _ = _voiced_phrase(stationary=True, gains=gains, delay=0.323)
    _, _, report = _render(tmp_path, dry, reference, (0, 10))
    assert not report["coherentEchoRegions"]
