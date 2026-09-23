from __future__ import annotations

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
    # A4 for 100 ms, then C5 genuinely held for 150 ms: two real notes, not collapsed into one.
    points = _pitch([round(i * 0.01, 2) for i in range(10)], _A4) + _pitch(
        [round(i * 0.01, 2) for i in range(10, 25)], _C5
    )
    words = [WordTiming("laaa", 0.0, 0.25, 0.9)]
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


def test_a_short_note_only_a_third_away_is_kept_as_its_own_note() -> None:
    # The same brief-note shape as the octave spike above, but only a minor third (3 semitones) away --
    # a plausible ornament, not an outlier, so it must survive as its own note.
    points = (
        _pitch([round(i * 0.02, 2) for i in range(6)], _A4)
        + _pitch([round(0.12 + i * 0.02, 2) for i in range(5)], _C5)
        + _pitch([round(0.22 + i * 0.02, 2) for i in range(10)], _A4)
    )
    words = [WordTiming("laaa", 0.0, 0.42, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    notes = document.words[0].notes
    assert any(note.note == 72 for note in notes)


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
