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
