from __future__ import annotations

from backend.ai.domain import PitchPoint
from backend.analysis.scoring import score_pitch
from backend.lyrics.domain import LyricsDocument, Note, Word


def _frequency(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def test_scoring_follows_runtime_tempo_and_transposition() -> None:
    reference = LyricsDocument(
        "Song",
        "Artist",
        4.0,
        120.0,
        "C",
        "la",
        (Word("la", 1.9, 2.2, (Note(60, 1.9, 2.2),)),),
    )
    actual = (PitchPoint(1.0, _frequency(62), 0.99),)
    adjustments = (
        {
            "elapsedSeconds": 0.0,
            "sourceSeconds": 1.0,
            "playbackRate": 1.0,
            "keyShift": 0,
        },
        {
            "elapsedSeconds": 0.5,
            "sourceSeconds": 1.5,
            "playbackRate": 1.0,
            "keyShift": 2,
        },
    )

    score = score_pitch(reference, actual, adjustments)

    assert score.pitch_accuracy_percent == 100.0
    assert score.mean_semitone_deviation < 0.001


def test_scoring_uses_the_same_practical_one_semitone_tolerance_as_karaoke() -> None:
    reference = LyricsDocument(
        "Song", "Artist", 2.0, 120.0, "A", "la",
        (Word("la", 0.0, 2.0, (Note(69, 0.0, 2.0),)),),
    )

    inside = score_pitch(reference, (PitchPoint(1.0, 440.0 * 2 ** (0.8 / 12), 0.99),))
    outside = score_pitch(reference, (PitchPoint(1.0, 440.0 * 2 ** (1.1 / 12), 0.99),))

    assert inside.pitch_accuracy_percent == 100.0
    assert outside.pitch_accuracy_percent == 0.0


def test_pitch_score_is_the_percentage_of_half_covered_green_notes_before_stop() -> None:
    reference = LyricsDocument(
        "Song", "Artist", 4.0, 120.0, "A", "la la la la",
        tuple(
            Word("la", float(index), float(index + 1), (Note(69 + index, float(index), float(index + 1)),))
            for index in range(4)
        ),
    )
    actual = tuple(
        PitchPoint(0.05 + index * 0.1, _frequency(69 if index < 6 else 71), 0.99)
        for index in range(10)
    ) + tuple(
        PitchPoint(1.05 + index * 0.1, _frequency(70 if index < 4 else 72), 0.99)
        for index in range(10)
    )

    score = score_pitch(reference, actual, performance_duration=3.0)

    assert score.pitch_accuracy_percent == 100.0 / 3.0


def test_saved_live_green_notes_override_pitch_guessed_from_the_master_mix() -> None:
    reference = LyricsDocument(
        "Song", "Artist", 2.0, 120.0, "A", "la",
        (Word("la", 0.0, 2.0, (Note(69, 0.0, 2.0),)),),
    )
    noisy_master_mix = (PitchPoint(1.0, _frequency(45), 0.99),)

    score = score_pitch(
        reference, noisy_master_mix,
        note_score={"hitNotes": 3, "totalNotes": 5},
    )

    assert score.pitch_accuracy_percent == 60.0
