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
