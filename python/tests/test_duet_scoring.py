from __future__ import annotations

import pytest

from backend.ai.domain import PitchPoint
from backend.analysis.scoring import score_pitch
from backend.domain_errors import DomainError
from backend.lyrics.domain import LyricsDocument


def performance(sung_frequency: float):
    document = LyricsDocument("Song", "Singer", 2, None, None, "", ())
    target = [PitchPoint(i * 0.05, 440, 1, True) for i in range(40)]
    actual = [
        PitchPoint(i * 0.05, sung_frequency if i >= 20 else 0, 1 if i >= 20 else 0, i >= 20)
        for i in range(40)
    ]
    return document, target, actual


def test_room_recording_analysis_excludes_the_other_singers_verse():
    document, target, actual = performance(440)
    result = score_pitch(
        document, actual, note_score={"ignoreSilence": True}, reference_pitch=target
    )
    assert result.pitch_accuracy_percent == pytest.approx(100)
    assert result.rhythm_accuracy_percent == pytest.approx(100)


def test_room_recording_analysis_does_not_ignore_wrong_sung_notes():
    document, target, actual = performance(440 * 2 ** (4 / 12))
    result = score_pitch(
        document, actual, note_score={"ignoreSilence": True}, reference_pitch=target
    )
    assert result.pitch_accuracy_percent == 0
    assert result.mean_semitone_deviation == pytest.approx(4)


def test_solo_recording_analysis_still_counts_missing_vocals():
    document, target, actual = performance(440)
    result = score_pitch(document, actual, reference_pitch=target)
    assert result.pitch_accuracy_percent == pytest.approx(50)


def test_silent_room_recording_has_no_assessable_performance():
    document, target, _ = performance(440)
    actual = [PitchPoint(i * 0.05, 0, 0, False) for i in range(40)]
    with pytest.raises(DomainError, match="reliable pitch evidence"):
        score_pitch(document, actual, note_score={"ignoreSilence": True}, reference_pitch=target)


def test_analysis_stability_accepts_moderate_vibrato_without_relaxing_wrong_notes():
    document, target, _ = performance(440)
    actual = [
        PitchPoint(i * 0.05, 440 * 2 ** ((0.75 if i % 2 else -0.75) / 12), 1, True)
        for i in range(40)
    ]
    result = score_pitch(document, actual, reference_pitch=target)
    assert result.note_stability_percent == pytest.approx(100)
    assert result.pitch_accuracy_percent == pytest.approx(100)
