"""Regional room returns survive mono and preserve continuous wet tails."""

from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, fftconvolve, sosfilt

from backend.domain_errors import DomainError
from backend.recordings.studio_adaptive_space import render_sends
from backend.recordings.studio_regional_space import (
    _candidate_region,
    _context_region,
    _local_relatedness,
)


RATE = 8000


def _room(seconds=30, changing=False):
    rng = np.random.default_rng(7419)
    count = RATE * seconds
    envelope = np.repeat(rng.uniform(0.3, 1, seconds * 4), RATE // 4)
    envelope = gaussian_filter1d(envelope, RATE * 0.025)
    direct = (
        sosfilt(
            butter(2, (500, 3000), fs=RATE, btype="bandpass", output="sos"),
            rng.normal(0, 0.06, count),
        )
        * envelope
    )
    returns = []
    for _ in range(2):
        impulse = rng.normal(size=round(RATE * 0.65))
        impulse *= np.exp(-6.907755 * np.arange(len(impulse)) / (RATE * 0.65))
        impulse[: round(RATE * 0.03)] = 0
        impulse /= np.linalg.norm(impulse)
        returns.append(fftconvolve(direct, impulse)[:count])
    gain = np.repeat([0.1, 0.4], count // 2) if changing else np.full(count, 0.4)
    wet = np.column_stack(returns) * gaussian_filter1d(gain, RATE * 0.12)[:, None]
    dry = np.column_stack((direct, direct))
    return dry, dry + wet


def _arrangement(count, boundaries=None):
    seconds = count / RATE
    edges = boundaries or (0, seconds)
    times = (np.arange(int(np.ceil(seconds * 4))) + 0.5) / 4
    return SimpleNamespace(
        frames=count,
        rate=RATE,
        duration_seconds=seconds,
        times=times,
        reference_valid=np.ones(len(times), dtype=bool),
        sections=tuple(
            SimpleNamespace(start_seconds=a, end_seconds=b, confidence=1.0)
            for a, b in zip(edges[:-1], edges[1:])
        ),
    )


def _render(root, dry, reference, boundaries=None, cancel=None, gap=None):
    source, backing, target = (root / f"{name}.wav" for name in ("dry", "music", "result"))
    sf.write(source, dry, RATE, subtype="FLOAT")
    sf.write(backing, dry * 0.5, RATE, subtype="FLOAT")
    ref = root / "reference.wav" if reference is not None else None
    if ref is not None:
        sf.write(ref, reference, RATE, subtype="FLOAT")
    arrangement = _arrangement(len(dry), boundaries)
    if gap is not None:
        arrangement.reference_valid[
            (arrangement.times >= gap[0]) & (arrangement.times < gap[1])
        ] = False
    report = render_sends(
        source,
        backing,
        target,
        cancel or threading.Event(),
        reference=ref,
        arrangement=arrangement,
    )
    return sf.read(target, always_2d=True)[0], report


def _ratio(wet, dry):
    return 10 * np.log10(max(float(np.mean(wet**2)), 1e-30) / np.mean(dry**2))


def test_dense_room_return_survives_mono_and_preserves_the_dry_timeline(tmp_path):
    dry, reference = _room(seconds=18)
    output, report = _render(tmp_path, dry, reference)
    wet = output - dry
    mono = _ratio(wet.mean(axis=1), dry.mean(axis=1))
    expected = _ratio((reference - dry).mean(axis=1), dry.mean(axis=1))
    assert abs(mono - expected) < 6
    assert -25 < mono < -5
    assert output.shape == dry.shape
    assert np.isfinite(output).all()
    assert report["dryPathUnity"] is True
    assert report["status"] == "estimated-reference-ambience"
    assert "regional-ambience" in report["buses"]
    assert report["buses"]["regional-ambience"]["monoWetToDryDb"] == pytest.approx(mono, abs=0.01)


def test_room_level_follows_sections_without_switching_on_alternating_words(tmp_path):
    dry, reference = _room(changing=True)
    output, report = _render(tmp_path, dry, reference, (0, 15, 30))
    wet = (output - dry).mean(axis=1)
    before, after = slice(2 * RATE, 13 * RATE), slice(17 * RATE, 28 * RATE)
    first = _ratio(wet[before], dry[before].mean(axis=1))
    last = _ratio(wet[after], dry[after].mean(axis=1))
    assert last > first + 8
    assert len(report["ambienceRegions"]) == 2
    for start in range(2, 13, 2):
        assert (
            _ratio(wet[start * RATE : (start + 2) * RATE], dry[start * RATE : (start + 2) * RATE])
            > first - 4
        )
    for start in range(17, 28, 2):
        assert (
            _ratio(wet[start * RATE : (start + 2) * RATE], dry[start * RATE : (start + 2) * RATE])
            > last - 4
        )


def test_tail_crosses_region_boundary_but_cannot_create_audio_from_silence(tmp_path):
    dry, reference = _room()
    dry[:RATE] = 0
    dry[15 * RATE :] = 0
    output, _ = _render(tmp_path, dry, reference, (0, 15, 30))
    np.testing.assert_allclose(output[:RATE], 0, atol=1e-8)
    assert np.sqrt(np.mean(output[15 * RATE : round(15.25 * RATE)] ** 2)) > 1e-5
    np.testing.assert_allclose(output[17 * RATE :], 0, atol=1e-8)


def test_short_transition_residue_cannot_hide_a_supported_inner_room(tmp_path):
    dry, reference = _room(seconds=24)
    reference[:RATE] = dry[:RATE] + 8 * (reference[:RATE] - dry[:RATE])
    reference[-RATE:] = dry[-RATE:] + 8 * (reference[-RATE:] - dry[-RATE:])
    output, report = _render(tmp_path, dry, reference)
    middle = slice(3 * RATE, 20 * RATE)
    assert _ratio((output - dry)[middle].mean(axis=1), dry[middle].mean(axis=1)) > -25
    assert report["ambienceRegions"]


def test_short_region_keeps_a_qualified_whole_recording_room_context(tmp_path):
    dry, reference = _room(seconds=18)
    output, report = _render(tmp_path, dry, reference, (0, 15, 18))
    last = slice(16 * RATE, 18 * RATE)
    assert _ratio((output - dry)[last].mean(axis=1), dry[last].mean(axis=1)) > -25
    context = [region for region in report["ambienceRegions"] if region["startSeconds"] == 15]
    assert context and context[0]["localFit"] is False
    assert context[0]["evidenceOrigin"] == "whole-recording-context"


def test_every_disjoint_reference_run_keeps_its_evidence_without_filling_the_gap(tmp_path):
    dry, reference = _room(seconds=24)
    output, report = _render(tmp_path, dry, reference, gap=(8, 10))
    for start, end in ((3, 6), (14, 20)):
        section = slice(start * RATE, end * RATE)
        assert _ratio((output - dry)[section].mean(axis=1), dry[section].mean(axis=1)) > -25
    np.testing.assert_allclose(
        output[9 * RATE : round(9.7 * RATE)], dry[9 * RATE : round(9.7 * RATE)], atol=1e-8
    )
    assert [(r["startSeconds"], r["endSeconds"]) for r in report["ambienceRegions"]] == [
        (0, 8),
        (10, 24),
    ]


def test_unknown_gap_input_cannot_excite_the_next_valid_room(tmp_path):
    dry, reference = _room(seconds=24)
    burst = dry[round(9.93 * RATE) : round(9.98 * RATE)].copy()
    dry[8 * RATE : 12 * RATE] = 0
    dry[round(9.93 * RATE) : round(9.98 * RATE)] = burst
    output, _ = _render(tmp_path, dry, reference, gap=(8, 10))
    np.testing.assert_allclose(output[10 * RATE : 11 * RATE], 0, atol=1e-8)
    assert np.mean((output - dry)[13 * RATE : 14 * RATE] ** 2) > 1e-6


@pytest.mark.parametrize("kind", ["pan", "unrelated"])
def test_global_room_context_cannot_invent_ambience_in_a_different_dry_region(tmp_path, kind):
    dry, reference = _room(seconds=18)
    reference[15 * RATE :] = dry[15 * RATE :]
    if kind == "pan":
        reference[15 * RATE :] *= (1.2, 0.8)
    else:
        noise = np.random.default_rng(62).normal(0, 0.006, 3 * RATE)
        reference[15 * RATE :] += np.column_stack((noise, -noise))
    output, _ = _render(tmp_path, dry, reference, (0, 15, 18))
    np.testing.assert_allclose(output[16 * RATE :], dry[16 * RATE :], atol=1e-8)


@pytest.mark.parametrize("kind", ["missing", "dry", "pan", "opposite-phase", "unrelated"])
def test_ambience_needs_delayed_evidence_and_does_not_invent_wet_audio(tmp_path, kind):
    dry, _ = _room(seconds=18)
    reference = dry.copy()
    if kind == "missing":
        reference = None
    elif kind == "pan":
        reference *= (1.2, 0.8)
    elif kind == "opposite-phase":
        reference[:, 1] *= -1
    elif kind == "unrelated":
        noise = np.random.default_rng(19).normal(0, 0.02, reference.shape)
        reference += noise
    output, report = _render(tmp_path, dry, reference)
    np.testing.assert_allclose(output, dry, atol=1e-8)
    assert not report["applied"]


def test_existing_room_is_not_added_twice(tmp_path):
    _, reference = _room(seconds=18)
    output, report = _render(tmp_path, reference, reference)
    np.testing.assert_allclose(output, reference, atol=1e-8)
    assert not report["applied"]


def test_regional_space_honors_cancellation(tmp_path):
    dry, reference = _room(seconds=4)
    event = threading.Event()
    event.set()
    with pytest.raises(DomainError):
        _render(tmp_path, dry, reference, cancel=event)


def test_periodic_pulsation_is_ambiguous_even_with_a_delayed_envelope():
    time = np.arange(600) * 0.02
    pulse = sum(np.exp(-0.5 * ((time - onset) / 0.04) ** 2) for onset in range(12))
    values = np.column_stack((pulse**2, np.roll(pulse, 8) ** 2))
    assert _local_relatedness(values) == 0


def test_periodic_energy_cannot_bypass_ambiguity_through_a_local_room_fit():
    time = np.arange(600) * 0.02
    pulse = sum(np.exp(-0.5 * ((time - onset) / 0.04) ** 2) for onset in range(12))
    expected = np.zeros((len(time), 2, 2))
    expected[:, 1] = np.column_stack((pulse**2, 0.1 * np.roll(pulse, 8) ** 2))
    existing = expected.copy()
    existing[:, :, 1] = 0
    assert _candidate_region(0, 12, expected, existing, [None, None]) is None


def test_weak_related_room_energy_is_compared_with_a_temporal_null():
    rng = np.random.default_rng(292)
    mid = rng.uniform(0.2, 1, 1000)
    side = 0.25 * np.roll(mid, 8) + 0.75 * rng.uniform(0.2, 1, len(mid))
    expected = np.zeros((len(mid), 2, 2))
    expected[:, 1] = np.column_stack((mid**2, side**2))
    existing = expected.copy()
    existing[:, :, 1] = 0
    response = np.zeros(31)
    response[8] = 0.1
    region = _context_region((0, 20), expected, existing, (response, 0.2))
    assert region is not None and region.local_fit is False


def test_short_or_slow_envelopes_have_insufficient_independent_evidence():
    short = np.linspace(0.01, 1, 60)
    slow = np.linspace(0.01, 1, 600)
    for envelope in (short, slow):
        values = np.column_stack((envelope**2, np.roll(envelope, 8) ** 2))
        assert _local_relatedness(values) == 0
