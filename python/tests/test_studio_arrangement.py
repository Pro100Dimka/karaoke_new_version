"""Arrangement evidence follows sustained musical context, not isolated events."""

import json
from pathlib import Path
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings.studio_arrangement import analyze_arrangement


RATE = 8000


def _write(root: Path, name: str, samples: np.ndarray, rate: int = RATE) -> Path:
    target = root / f"{name}.wav"
    sf.write(target, samples, rate, subtype="FLOAT")
    return target


def _song(duration: float = 48, semitones: float = 0) -> tuple[np.ndarray, np.ndarray]:
    time = np.arange(round(RATE * duration)) / RATE
    pitch = 2 ** (semitones / 12)
    sparse = sum(np.sin(2 * np.pi * note * pitch * time) for note in (220, 277.18, 329.63))
    dense = sum(
        np.sin(2 * np.pi * note * pitch * time) for note in (110, 164.81, 220, 440, 880, 1760, 2640)
    )
    noise = np.random.default_rng(46).normal(size=len(time))
    middle = (time >= duration / 3) & (time < 2 * duration / 3)
    backing = np.where(middle, 0.025 * dense + 0.025 * noise, 0.035 * sparse)
    syllables = (time % 1.7) < 1.2
    voice = 0.04 * np.sin(2 * np.pi * 330 * pitch * time) * syllables
    return backing, voice


def _analyze(root: Path, backing: np.ndarray, voice: np.ndarray | None):
    music = _write(root, "music", backing)
    reference = _write(root, "reference", voice) if voice is not None else None
    return analyze_arrangement(music, reference, threading.Event())


def test_repeated_parts_have_boundaries_density_and_stable_anchors(tmp_path):
    backing, voice = _song()
    plan = _analyze(tmp_path, backing, voice)
    boundaries = [part.start_seconds for part in plan.sections] + [plan.duration_seconds]
    np.testing.assert_allclose(boundaries, [0, 16, 32, 48], atol=1.5)
    first, middle, last = plan.sections
    assert first.repeat_group is not None
    assert first.repeat_group == last.repeat_group
    assert first.repeat_group != middle.repeat_group
    low = (plan.times > 4) & (plan.times < 12)
    high = (plan.times > 20) & (plan.times < 28)
    assert np.median(plan.density[high]) > np.median(plan.density[low]) + 0.15
    assert np.median(plan.voice_priority[high]) > np.median(plan.voice_priority[low])
    assert plan.stable_anchor[low].any() and plan.stable_anchor[high].any()
    assert all(part.confidence > 0 for part in plan.sections)
    assert all(part.anchor_start_seconds is not None for part in plan.sections)
    assert not any(word in json.dumps(plan.payload()) for word in ("verse", "chorus"))


@pytest.mark.parametrize("note_seconds", [0.8, 2.0])
def test_loud_notes_hits_and_short_pauses_do_not_create_sections(tmp_path, note_seconds):
    time = np.arange(RATE * 24) / RATE
    backing = 0.04 * (np.sin(2 * np.pi * 220 * time) + np.sin(2 * np.pi * 330 * time))
    voice = 0.04 * np.sin(2 * np.pi * (300 * time + 20 * np.sin(time)))
    backing[(time >= 8) & (time < 8.5)] *= 8
    backing += 0.15 * np.sin(2 * np.pi * 1300 * time) * ((time >= 12) & (time < 12 + note_seconds))
    pause = (time >= 18) & (time < 18.6)
    backing[pause], voice[pause] = 0, 0
    plan = _analyze(tmp_path, backing, voice)
    assert len(plan.sections) == 1
    assert np.isfinite(plan.density).all() and np.isfinite(plan.voice_priority).all()


def test_irregular_tempo_does_not_require_a_beat_grid(tmp_path):
    time = np.arange(RATE * 24) / RATE
    backing = 0.04 * (np.sin(2 * np.pi * 220 * time) + np.sin(2 * np.pi * 330 * time))
    for onset in np.cumsum(np.tile([0.43, 0.67, 0.51, 0.89], 10)):
        age = time - onset
        backing += (
            0.05
            * np.sin(2 * np.pi * 80 * time)
            * np.where((age >= 0) & (age < 0.15), np.exp(-40 * np.maximum(age, 0)), 0)
        )
    plan = _analyze(tmp_path, backing, 0.03 * np.sin(2 * np.pi * 350 * time))
    assert len(plan.sections) == 1
    assert len(plan.times) >= 80
    assert plan.stable_anchor.any()


def test_acappella_and_a_long_vocal_rest_remain_valid(tmp_path):
    time = np.arange(RATE * 20) / RATE
    singing = (time < 7) | (time >= 12)
    voice = 0.04 * np.sin(2 * np.pi * (220 * time + 25 * np.sin(time))) * singing
    plan = _analyze(tmp_path, np.zeros(len(time)), voice)
    assert np.max(plan.density) == 0
    rest = (plan.times > 8) & (plan.times < 11)
    sung = (plan.times > 2) & (plan.times < 5)
    assert not plan.vocal_activity[rest].any()
    assert np.max(plan.voice_priority[rest]) < 0.1
    assert np.median(plan.voice_priority[sung]) > 0.4
    assert plan.reference_valid.all()
    assert plan.sections[0].start_seconds == 0
    assert plan.sections[-1].end_seconds == pytest.approx(20)


def test_short_partial_timeline_still_has_continuous_evidence(tmp_path):
    backing, voice = _song(duration=2.4)
    backing, voice = backing[:-137], voice[:-137]
    plan = _analyze(tmp_path, backing, voice)
    assert plan.frames == len(backing) and plan.rate == RATE
    assert plan.duration_seconds == pytest.approx(len(backing) / RATE)
    assert len(plan.times) >= 8
    assert np.ptp(plan.density) > 0.05
    assert np.all(np.diff(plan.times) > 0)
    assert plan.times[-1] < plan.duration_seconds
    assert round(plan.sections[-1].end_seconds * RATE) == len(backing)


def test_shorter_different_rate_reference_is_unknown_after_coverage(tmp_path):
    time = np.arange(RATE * 20) / RATE
    backing = _write(tmp_path, "music", 0.04 * np.sin(2 * np.pi * 220 * time))
    reference_time = np.arange(round(11025 * 10.3)) / 11025
    reference = _write(
        tmp_path, "reference", 0.03 * np.sin(2 * np.pi * 330 * reference_time), 11025
    )
    plan = analyze_arrangement(backing, reference, threading.Event())
    assert plan.reference_valid[plan.times < 10].all()
    assert not plan.reference_valid[plan.times > 10.5].any()
    assert len(plan.sections) == 1
    assert plan.sections[-1].end_seconds == 20


def test_explicit_reference_gaps_are_not_instrumental_breaks(tmp_path):
    backing, voice = _song(duration=12)
    music = _write(tmp_path, "music", backing)
    reference = _write(tmp_path, "reference", voice)
    plan = analyze_arrangement(
        music, reference, threading.Event(), reference_intervals=((0.1, 3), (7, 12))
    )
    assert not plan.reference_valid[0]
    assert not plan.reference_valid[(plan.times > 3.2) & (plan.times < 6.8)].any()
    assert plan.reference_valid[plan.times > 7.2].all()
    assert np.isfinite(plan.voice_priority).all()


def test_gain_and_opposite_stereo_phase_do_not_change_the_map(tmp_path):
    backing, voice = _song()
    first = _analyze(tmp_path, backing, voice)
    music = _write(tmp_path, "stereo", np.column_stack((backing, -backing)) * 0.125)
    reference = _write(tmp_path, "stereo-reference", np.column_stack((voice, -voice)) * 0.125)
    second = analyze_arrangement(music, reference, threading.Event())
    np.testing.assert_allclose(first.density, second.density, atol=1e-6)
    np.testing.assert_allclose(first.voice_priority, second.voice_priority, atol=1e-6)
    assert [part.start_seconds for part in first.sections] == [
        part.start_seconds for part in second.sections
    ]
    assert [part.repeat_group for part in first.sections] == [
        part.repeat_group for part in second.sections
    ]


def test_global_key_change_preserves_structural_repetition(tmp_path):
    first = _analyze(tmp_path, *_song())
    music, voice = _song(semitones=3)
    shifted = analyze_arrangement(
        _write(tmp_path, "shifted", music),
        _write(tmp_path, "shifted-reference", voice),
        threading.Event(),
    )
    np.testing.assert_allclose(
        [part.start_seconds for part in shifted.sections],
        [part.start_seconds for part in first.sections],
        atol=1,
    )
    assert shifted.sections[0].repeat_group == shifted.sections[-1].repeat_group


def test_missing_reference_and_cancellation_are_explicit(tmp_path):
    backing, _ = _song(duration=8)
    music = _write(tmp_path, "music", backing)
    plan = analyze_arrangement(music, None, threading.Event())
    assert not plan.reference_valid.any()
    assert plan.payload()["referenceAvailable"] is False
    assert np.isfinite(plan.density).all()
    event = threading.Event()
    event.set()
    with pytest.raises(DomainError):
        analyze_arrangement(music, None, event)


def test_vocal_production_changes_are_detected_over_an_unchanged_loop(tmp_path):
    time = np.arange(RATE * 48) / RATE
    backing = 0.04 * (np.sin(2 * np.pi * 220 * time) + np.sin(2 * np.pi * 330 * time))
    phase = 2 * np.pi * (220 * time + 3 * np.sin(2 * np.pi * 4.7 * time))
    mid = 0.04 * (np.sin(phase) + 0.3 * np.sin(2 * phase))
    middle = (time >= 16) & (time < 32)
    side = 0.45 * np.roll(mid, round(0.043 * RATE)) * middle
    reference = np.column_stack((mid + side, mid - side))
    plan = _analyze(tmp_path, backing, reference)
    np.testing.assert_allclose(
        [part.start_seconds for part in plan.sections], [0, 16, 32], atol=1.5
    )
    assert plan.sections[0].repeat_group == plan.sections[2].repeat_group
    assert plan.sections[0].repeat_group is not None


def test_quiet_wide_tail_does_not_create_a_production_boundary(tmp_path):
    time = np.arange(RATE * 24) / RATE
    backing = 0.04 * np.sin(2 * np.pi * 220 * time)
    singing = (time < 8) | (time >= 16)
    mid = 0.04 * np.sin(2 * np.pi * 330 * time) * np.where(singing, 1, 0.001)
    side = 0.00004 * np.sin(2 * np.pi * 733 * time) * ((time >= 10) & (time < 14))
    plan = _analyze(tmp_path, backing, np.column_stack((mid + side, mid - side)))
    assert not any(9 < part.start_seconds < 15 for part in plan.sections)


def test_measurement_anchor_is_local_and_excludes_a_transient(tmp_path):
    time = np.arange(RATE * 36) / RATE
    backing = 0.04 * (np.sin(2 * np.pi * 220 * time) + np.sin(2 * np.pi * 330 * time))
    backing += 0.3 * np.sin(2 * np.pi * 1600 * time) * ((time >= 18) & (time < 18.8))
    plan = _analyze(tmp_path, backing, 0.03 * np.sin(2 * np.pi * 330 * time))
    assert len(plan.sections) == 1
    section = plan.sections[0]
    assert section.anchor_end_seconds - section.anchor_start_seconds <= 6
    assert not plan.stable_anchor[(plan.times >= 18.25) & (plan.times <= 18.75)].any()
