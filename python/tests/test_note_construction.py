from __future__ import annotations

import math

import pytest

from backend.ai.domain import PitchPoint, WordTiming
from backend.processing.algorithms import MusicMetadata, construct_document

_A4, _C5 = 440.0, 523.25


def _music() -> MusicMetadata:
    return MusicMetadata(bpm=None, key=None)


def _pitch(times: list[float], frequency: float) -> list[PitchPoint]:
    return [PitchPoint(time, frequency, 0.9) for time in times]


def test_short_note_never_overlaps_the_next_one() -> None:
    # A4 lasts only 20 ms before the pitch jumps to C5: the minimum note length must not push A4 over C5.
    points = _pitch([0.00, 0.01, 0.02], _A4) + _pitch(
        [0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10], _C5
    )
    words = [WordTiming("la", 0.0, 0.11, 0.9)]
    document = construct_document("t", "a", 1.0, "la", words, points, _music())
    notes = document.words[0].notes
    assert all(
        current.start >= previous.end for previous, current in zip(notes, notes[1:], strict=False)
    )
    assert all(note.end > note.start for note in notes)


@pytest.mark.parametrize("gap", [0.0, 0.02, 0.5])
def test_notes_stay_inside_the_word_whatever_the_gaps(gap: float) -> None:
    points = _pitch([0.00, 0.01], _A4) + _pitch([0.01 + gap, 0.02 + gap, 0.03 + gap], _C5)
    words = [WordTiming("la", 0.0, 0.05 + gap, 0.9)]
    document = construct_document("t", "a", 1.0, "la", words, points, _music())
    for note in document.words[0].notes:
        assert 0.0 <= note.start < note.end <= 0.05 + gap


def test_a_brief_wobble_does_not_split_off_its_own_note() -> None:
    # A4 held for 200 ms with a single 10 ms blip up to C5 in the middle -- measurement noise, not a real
    # note change -- must read back as one held A4, not three fragments.
    times = [round(i * 0.01, 2) for i in range(20)]
    points = [PitchPoint(t, _C5 if t == 0.10 else _A4, 0.9) for t in times]
    words = [WordTiming("laaa", 0.0, 0.2, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    notes = document.words[0].notes
    assert len(notes) == 1
    assert notes[0].note == 69


def test_a_note_change_sustained_long_enough_is_still_recognised() -> None:
    # A4 for 150 ms, then C5 genuinely held for 150 ms: two real notes, not collapsed into one.
    points = _pitch([round(i * 0.01, 2) for i in range(15)], _A4) + _pitch(
        [round(i * 0.01, 2) for i in range(15, 30)], _C5
    )
    words = [WordTiming("laaa", 0.0, 0.3, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    notes = document.words[0].notes
    assert [n.note for n in notes] == [69, 72]


def test_a_short_octave_spike_between_two_matching_notes_is_absorbed() -> None:
    # A4, a genuine 80 ms note change (long enough to survive the wobble debounce) up a full octave to
    # A5, then back to A4: an octave jump this brief between two otherwise-matching notes is a tracking
    # error, not real singing, so no note should be left standing an octave away.
    points = (
        _pitch([round(i * 0.02, 2) for i in range(6)], _A4)
        + _pitch([round(0.12 + i * 0.02, 2) for i in range(5)], 880.0)
        + _pitch([round(0.22 + i * 0.02, 2) for i in range(10)], _A4)
    )
    words = [WordTiming("laaa", 0.0, 0.42, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    notes = document.words[0].notes
    assert all(note.note == 69 for note in notes)


def _ornament(count: int) -> list[PitchPoint]:
    """A4 for 120 ms, C5 (a minor third up) for `count` 10 ms tracker frames, then A4 for 200 ms."""
    after = round(0.12 + count * 0.01, 2)
    return (
        _pitch([round(i * 0.01, 2) for i in range(12)], _A4)
        + _pitch([round(0.12 + i * 0.01, 2) for i in range(count)], _C5)
        + _pitch([round(after + i * 0.01, 2) for i in range(20)], _A4)
    )


def test_a_note_a_third_away_held_long_enough_to_sing_is_kept() -> None:
    # A 160 ms minor third is a plausible ornament a singer can see and reach: it keeps its own note.
    words = [WordTiming("laaa", 0.0, 0.48, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, _ornament(16), _music())
    assert [note.note for note in document.words[0].notes] == [69, 72, 69]


def test_a_note_too_short_to_sing_is_folded_into_its_neighbours() -> None:
    # The same third lasting only 100 ms is gone before a singer can reach it, so it is not drawn.
    words = [WordTiming("laaa", 0.0, 0.42, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, _ornament(10), _music())
    assert [note.note for note in document.words[0].notes] == [69]


def test_a_long_note_far_from_its_neighbours_is_kept() -> None:
    # The same octave jump as above, but genuinely held for 300 ms -- too long to be a tracking blip, so
    # it must be kept even though it sits far from both neighbours.
    points = (
        _pitch([round(i * 0.02, 2) for i in range(6)], _A4)
        + _pitch([round(0.12 + i * 0.02, 2) for i in range(15)], 880.0)
        + _pitch([round(0.42 + i * 0.02, 2) for i in range(10)], _A4)
    )
    words = [WordTiming("laaa", 0.0, 0.62, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    notes = document.words[0].notes
    assert any(note.note == 81 for note in notes)


def test_a_scoop_into_a_held_note_does_not_draw_a_staircase() -> None:
    # The voice slides C4 -> C#4 -> D4 over 200 ms and then holds D4: the singer aims at C4 and D4, so
    # the 60 ms C#4 passed through on the way must not become its own note.
    points = (
        _pitch([round(i * 0.01, 2) for i in range(14)], 261.63)
        + _pitch([round(0.14 + i * 0.01, 2) for i in range(6)], 277.18)
        + _pitch([round(0.20 + i * 0.01, 2) for i in range(60)], 293.66)
    )
    words = [WordTiming("please", 0.0, 0.8, 0.9)]
    document = construct_document("t", "a", 1.0, "please", words, points, _music())
    assert [note.note for note in document.words[0].notes] == [60, 62]


def test_vibrato_around_a_semitone_boundary_stays_one_note() -> None:
    # A held note sung around 69.5 with +-0.4 semitone vibrato crosses the A4/A#4 boundary every few
    # frames; rounding each frame alone would chop it into a flurry of alternating notes.
    times = [round(i * 0.01, 2) for i in range(80)]
    semitones = [69.5 + 0.4 * math.sin(2 * math.pi * 5.5 * t) for t in times]
    points = [PitchPoint(t, 440.0 * 2 ** ((s - 69) / 12), 0.9) for t, s in zip(times, semitones)]
    words = [WordTiming("laaa", 0.0, 0.8, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    assert len(document.words[0].notes) == 1


def test_a_point_on_the_last_instant_of_a_word_never_yields_an_empty_note() -> None:
    points = _pitch([0.0, 0.05, 0.1], _A4) + _pitch([0.2], _C5)
    words = [WordTiming("la", 0.0, 0.2, 0.9)]
    document = construct_document("t", "a", 1.0, "la", words, points, _music())
    assert all(note.end > note.start for note in document.words[0].notes)
