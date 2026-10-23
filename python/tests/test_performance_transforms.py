from __future__ import annotations

import math
import pytest

from backend.ai.domain import PitchPoint
from backend.analysis.scoring import score_pitch
from backend.domain_errors import DomainError
from backend.lyrics.domain import LyricsDocument, Note, Word


def _frequency(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _vocal_contour() -> tuple[PitchPoint, ...]:
    return tuple(
        PitchPoint(index / 100, 440 * 2 ** (0.4 * math.sin(index / 4) / 12), 0.95)
        if 20 <= index < 80 or 110 <= index < 175
        else PitchPoint(index / 100, 0, 0)
        for index in range(200)
    )


def test_identical_reference_audio_scores_perfectly_despite_vibrato_and_wrong_live_values() -> None:
    document = LyricsDocument(
        "Song", "Artist", 2, 120, "A", "la", (Word("la", 0, 2, (Note(69, 0, 2),)),)
    )
    contour = _vocal_contour()
    score = score_pitch(
        document,
        contour,
        performance_duration=2,
        note_score={
            "hitNotes": 0,
            "totalNotes": 100,
            "rhythmAccuracyPercent": 3,
            "noteStabilityPercent": 2,
        },
        reference_pitch=contour,
    )
    assert score.pitch_accuracy_percent == pytest.approx(100)
    assert score.rhythm_accuracy_percent == pytest.approx(100)
    assert score.note_stability_percent == pytest.approx(100)
    assert score.mean_semitone_deviation == pytest.approx(0, abs=1e-9)


def test_section_score_counts_missing_voice_instead_of_showing_perfect_partial_singing() -> None:
    document = LyricsDocument(
        "Song", "Artist", 2, 120, "A", "la", (Word("la", 0, 2, (Note(69, 0, 2),)),)
    )
    reference = tuple(PitchPoint(index / 100, 440, 0.95) for index in range(200))
    actual = tuple(
        PitchPoint(p.time, p.frequency if p.time < 1 else 0, p.confidence if p.time < 1 else 0)
        for p in reference
    )
    result = score_pitch(document, actual, performance_duration=2, reference_pitch=reference)
    assert result.pitch_accuracy_percent == pytest.approx(50)
    assert result.sections[0].pitch_accuracy_percent == pytest.approx(50)


@pytest.mark.parametrize(
    "rate, shift, start, duration",
    [
        (1, 0, 0, 1),
        (0.5, 2, 0, 3),
        (1.5, -3, 0, 1),
        (1, 0, 0.7, 0.8),
    ],
)
def test_contours_follow_tempo_transposition_and_only_the_recorded_span(
    rate: float,
    shift: float,
    start: float,
    duration: float,
) -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = tuple(PitchPoint(i / 100, 440 * 2 ** (i / 500 / 12), 0.95) for i in range(200))
    actual = tuple(
        PitchPoint(i / 100, 440 * 2 ** ((start / 5 + i * rate / 500 + shift) / 12), 0.95)
        for i in range(round(duration * 100))
    )
    adjustments = (
        {"elapsedSeconds": 0, "sourceSeconds": start, "playbackRate": rate, "keyShift": shift},
    )
    result = score_pitch(document, actual, adjustments, duration, reference_pitch=reference)
    assert result.pitch_accuracy_percent == pytest.approx(100)
    assert result.rhythm_accuracy_percent == pytest.approx(100)
    assert result.note_stability_percent > 99.8
    assert result.mean_semitone_deviation < 0.002


def test_contour_comparison_ignores_unpitched_noise_marked_inactive() -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = _vocal_contour()
    actual = tuple(p if p.frequency else PitchPoint(p.time, 150, 0.9, False) for p in reference)
    result = score_pitch(document, actual, performance_duration=2, reference_pitch=reference)
    assert result.pitch_accuracy_percent == pytest.approx(100)
    assert result.rhythm_accuracy_percent == pytest.approx(100)


def test_offline_pitch_accepts_the_same_octave_equivalent_register_as_live_karaoke() -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = _vocal_contour()
    lower_register = tuple(PitchPoint(p.time, p.frequency / 2, p.confidence) for p in reference)
    result = score_pitch(
        document, lower_register, performance_duration=2, reference_pitch=reference
    )
    assert result.pitch_accuracy_percent == pytest.approx(100)
    assert result.note_stability_percent == pytest.approx(100)
    assert result.mean_semitone_deviation == pytest.approx(0, abs=1e-9)


def test_uncertain_fundamental_is_not_reported_as_silence_or_bad_rhythm() -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = tuple(
        PitchPoint(p.time, p.frequency, p.confidence, p.frequency > 0) for p in _vocal_contour()
    )
    actual = tuple(
        PitchPoint(p.time, p.frequency, p.confidence if i % 2 else 0.1, p.audio_active)
        for i, p in enumerate(reference)
    )
    result = score_pitch(document, actual, performance_duration=2, reference_pitch=reference)
    assert result.pitch_accuracy_percent == pytest.approx(100)
    assert result.rhythm_accuracy_percent == pytest.approx(100)


def test_one_pitch_detection_outlier_does_not_destroy_the_whole_stability_score() -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = _vocal_contour()
    actual = tuple(
        PitchPoint(p.time, p.frequency * 2 ** ((4 if i == 50 else 0) / 12), p.confidence)
        for i, p in enumerate(reference)
    )
    result = score_pitch(document, actual, performance_duration=2, reference_pitch=reference)
    assert 98 < result.note_stability_percent < 100


def test_pitch_within_karaoke_tolerance_can_still_be_unsteady() -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = _vocal_contour()
    actual = tuple(
        PitchPoint(p.time, p.frequency * 2 ** ((0.8 if i % 2 else -0.8) / 12), p.confidence)
        for i, p in enumerate(reference)
    )
    result = score_pitch(document, actual, performance_duration=2, reference_pitch=reference)
    assert result.pitch_accuracy_percent == pytest.approx(100)
    assert result.note_stability_percent < 25


def test_two_good_samples_cannot_award_perfect_pitch_to_an_unmeasurable_recording() -> None:
    document = LyricsDocument("Song", "Artist", 2, 120, "A", "la", ())
    reference = tuple(PitchPoint(i / 100, 440, 0.95, True) for i in range(200))
    actual = tuple(
        PitchPoint(p.time, p.frequency, 0.95 if i < 2 else 0.01, True)
        for i, p in enumerate(reference)
    )
    with pytest.raises(DomainError, match="reliable pitch"):
        score_pitch(document, actual, performance_duration=2, reference_pitch=reference)


@pytest.mark.parametrize(
    "rate, shift, changes, expected",
    [
        (1, 0, False, 1.5),
        (0.8, 0, False, None),
        (1, 2, False, None),
        (1, 0, True, None),
    ],
)
def test_waveform_calibration_requires_an_unmodified_continuous_reference(
    rate: float,
    shift: float,
    changes: bool,
    expected: float | None,
) -> None:
    from backend.analysis.scoring import reference_audio_start

    adjustments = [
        {"elapsedSeconds": 0, "sourceSeconds": 1.5, "playbackRate": rate, "keyShift": shift}
    ]
    if changes:
        adjustments.append({**adjustments[0], "elapsedSeconds": 2, "sourceSeconds": 8})
    assert reference_audio_start(adjustments) == expected


@pytest.mark.parametrize("mistake", ["wrong_notes", "silence", "late", "singing_in_rests"])
def test_audio_comparison_does_not_reward_wrong_notes_silence_or_wrong_rhythm(mistake: str) -> None:
    document = LyricsDocument(
        "Song", "Artist", 2, 120, "A", "la", (Word("la", 0, 2, (Note(69, 0, 2),)),)
    )
    reference = _vocal_contour()
    transformations = {
        "wrong_notes": lambda p: PitchPoint(p.time, p.frequency * 2 ** (3 / 12), p.confidence),
        "silence": lambda p: PitchPoint(p.time, 0, 0),
        "late": lambda p: PitchPoint(p.time + 0.15, p.frequency, p.confidence),
        "singing_in_rests": lambda p: PitchPoint(p.time, p.frequency or 440, 0.95),
    }
    actual = tuple(transformations[mistake](point) for point in reference)
    score = score_pitch(
        document,
        actual,
        performance_duration=2,
        note_score={
            "hitNotes": 100,
            "totalNotes": 100,
            "rhythmAccuracyPercent": 100,
            "noteStabilityPercent": 100,
        },
        reference_pitch=reference,
    )
    if mistake in {"wrong_notes", "silence"}:
        assert score.pitch_accuracy_percent == 0
    if mistake == "wrong_notes":
        assert score.rhythm_accuracy_percent == pytest.approx(100)
        assert score.note_stability_percent == pytest.approx(100)
    else:
        assert score.rhythm_accuracy_percent < 80


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


def test_notes_before_first_playback_adjustment_count_toward_pitch_score() -> None:
    reference = LyricsDocument(
        "Song",
        "Artist",
        2.0,
        120.0,
        "A",
        "la la",
        (
            Word("la", 0.0, 1.0, (Note(69, 0.0, 1.0),)),
            Word("la", 1.0, 2.0, (Note(71, 1.0, 2.0),)),
        ),
    )
    actual = tuple(PitchPoint(0.05 + index * 0.1, _frequency(69), 0.99) for index in range(10))
    adjustments = (
        {"elapsedSeconds": 1.0, "sourceSeconds": 1.0, "playbackRate": 1.0, "keyShift": 0},
    )

    score = score_pitch(reference, actual, adjustments, performance_duration=2.0)

    assert score.pitch_accuracy_percent == 50.0


def test_scoring_uses_the_same_practical_one_semitone_tolerance_as_karaoke() -> None:
    reference = LyricsDocument(
        "Song",
        "Artist",
        2.0,
        120.0,
        "A",
        "la",
        (Word("la", 0.0, 2.0, (Note(69, 0.0, 2.0),)),),
    )

    inside = score_pitch(reference, (PitchPoint(1.0, 440.0 * 2 ** (0.8 / 12), 0.99),))
    outside = score_pitch(reference, (PitchPoint(1.0, 440.0 * 2 ** (1.1 / 12), 0.99),))

    assert inside.pitch_accuracy_percent == 100.0
    assert outside.pitch_accuracy_percent == 0.0


def test_pitch_score_is_the_percentage_of_half_covered_green_notes_before_stop() -> None:
    reference = LyricsDocument(
        "Song",
        "Artist",
        4.0,
        120.0,
        "A",
        "la la la la",
        tuple(
            Word(
                "la",
                float(index),
                float(index + 1),
                (Note(69 + index, float(index), float(index + 1)),),
            )
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
        "Song",
        "Artist",
        2.0,
        120.0,
        "A",
        "la",
        (Word("la", 0.0, 2.0, (Note(69, 0.0, 2.0),)),),
    )
    noisy_master_mix = (PitchPoint(1.0, _frequency(45), 0.99),)

    score = score_pitch(
        reference,
        noisy_master_mix,
        note_score={"hitNotes": 3, "totalNotes": 5},
    )

    assert score.pitch_accuracy_percent == 60.0


def test_saved_live_note_metrics_override_values_guessed_from_the_master_mix() -> None:
    reference = LyricsDocument(
        "Song",
        "Artist",
        2.0,
        120.0,
        "A",
        "la",
        (Word("la", 0.0, 2.0, (Note(69, 0.0, 2.0),)),),
    )
    noisy_master_mix = tuple(
        PitchPoint(0.1 * index, _frequency(69) * 2 ** ((index % 3 - 1) / 12), 0.99)
        for index in range(1, 20)
    )

    score = score_pitch(
        reference,
        noisy_master_mix,
        performance_duration=2.0,
        note_score={
            "hitNotes": 1,
            "totalNotes": 1,
            "rhythmAccuracyPercent": 78.5,
            "noteStabilityPercent": 91.25,
        },
    )

    assert score.rhythm_accuracy_percent == 78.5
    assert score.note_stability_percent == 91.25


def test_rhythm_and_stability_are_scored_inside_reference_notes() -> None:
    reference = LyricsDocument(
        "Song",
        "Artist",
        2.0,
        120.0,
        "A",
        "la la",
        (
            Word("la", 0.0, 1.0, (Note(69, 0.0, 1.0),)),
            Word("la", 1.0, 2.0, (Note(71, 1.0, 2.0),)),
        ),
    )
    on_time_and_steady = tuple(
        PitchPoint(0.05 + index * 0.05, _frequency(69), 0.99) for index in range(19)
    ) + tuple(PitchPoint(1.05 + index * 0.05, _frequency(71), 0.99) for index in range(19))
    late_and_wobbly = tuple(
        PitchPoint(
            0.55 + index * 0.05,
            _frequency(69) * 2 ** ((-0.8 if index % 2 else 0.8) / 12),
            0.99,
        )
        for index in range(9)
    )

    good = score_pitch(reference, on_time_and_steady, performance_duration=2.0)
    weak = score_pitch(reference, late_and_wobbly, performance_duration=2.0)

    assert good.rhythm_accuracy_percent >= 90.0
    assert good.note_stability_percent >= 99.0
    assert weak.rhythm_accuracy_percent < good.rhythm_accuracy_percent
    assert weak.note_stability_percent < good.note_stability_percent
