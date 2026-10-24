from __future__ import annotations

import math

import numpy as np
import pytest
import torch

from backend.ai.domain import PitchPoint, WordTiming
import backend.ai_worker.pitch as pitch_worker
import backend.processing.reporting as processing_reporting
from backend.infrastructure.command_ai_provider import _pitch as decode_pitch
from backend.processing.algorithms import MusicMetadata, construct_document, stabilize_pitch

_A4, _C5 = 440.0, 523.25


def test_constructed_notes_keep_the_measured_contour_through_codec_and_manual_transposition() -> (
    None
):
    from dataclasses import replace
    from backend.lyrics.codec import decode_document, encode_document

    points = tuple(
        PitchPoint(i / 100, 440 * 2 ** (0.4 * math.sin(i) / 12), 0.99) for i in range(100)
    )
    document = construct_document("t", "a", 1, "la", (WordTiming("la", 0, 1, 1),), points, _music())
    note = document.words[0].notes[0]
    assert len(note.contour) == len(points)
    assert note.contour[20][1] == pytest.approx(0.4 * math.sin(20))
    edited = replace(document, words=(replace(document.words[0], notes=(replace(note, note=72),)),))
    assert decode_document(encode_document(edited)) == edited


def _music() -> MusicMetadata:
    return MusicMetadata(bpm=None, key=None)


def test_word_boundaries_do_not_turn_a_vibrato_peak_into_a_different_sung_note() -> None:
    points = [
        PitchPoint(i / 100, 440 * 2 ** ((0.6 if 45 <= i < 51 else 0.0) / 12), 0.99, True)
        for i in range(100)
    ]
    words = [
        WordTiming(text, a, b, 1)
        for text, a, b in [("we", 0, 0.45), ("are", 0.45, 0.51), ("here", 0.51, 1)]
    ]

    document = construct_document("t", "a", 1, "we are here", words, points, _music())

    assert [note.note for word in document.words for note in word.notes] == [69, 69, 69]
    assert document.words[1].notes[0].contour[0][1] == pytest.approx(0.6)


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


def test_a_sustained_fast_octave_change_cannot_be_declared_noise_only_by_duration() -> None:
    # Clean A4 -> A5 -> A4 estimates support a fast ornament; duration alone does not prove error.
    points = (
        _pitch([round(i * 0.02, 2) for i in range(6)], _A4)
        + _pitch([round(0.12 + i * 0.02, 2) for i in range(5)], 880.0)
        + _pitch([round(0.22 + i * 0.02, 2) for i in range(10)], _A4)
    )
    words = [WordTiming("laaa", 0.0, 0.42, 0.9)]
    document = construct_document("t", "a", 1.0, "laaa", words, points, _music())
    notes = document.words[0].notes
    assert [note.note for note in notes] == [69, 81, 69]


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


def test_unobserved_pitch_gap_and_word_tail_do_not_become_a_required_held_note() -> None:
    points = _pitch([i / 100 for i in range(20)], _A4) + _pitch(
        [i / 100 for i in range(80, 100)], _A4
    )
    document = construct_document(
        "t", "a", 3.0, "la", [WordTiming("la", 0.0, 3.0, 0.9)], points, _music()
    )
    notes = document.words[0].notes
    assert len(notes) == 2
    assert notes[0].end == pytest.approx(0.2)
    assert notes[1].start == pytest.approx(0.8)
    assert notes[1].end == pytest.approx(1.0)
    assert document.words[0].end == 3.0, "pitch absence cannot redefine a word's end"


def _audio_evidenced_points(monkeypatch, *, silent: bool) -> tuple[PitchPoint, ...]:
    # Identical 80 ms pitch loss with either continuing sound or digital silence. The waveform,
    # independently of the pitch estimates, determines which hole can be bridged.
    rate = 16_000
    times = np.arange(rate) / rate
    samples = (0.4 * np.sin(2 * np.pi * _A4 * times)).astype(np.float32)
    if silent:
        samples[int(0.4 * rate) : int(0.48 * rate)] = 0.0
    frequency = torch.full((1, 101), _A4)
    confidence = torch.full((1, 101), 0.9)
    confidence[:, 40:48] = 0.0
    monkeypatch.setattr(pitch_worker, "read_mono", lambda *_: samples)
    monkeypatch.setattr(pitch_worker, "device", lambda: "cpu")
    monkeypatch.setattr(
        pitch_worker.torchcrepe, "predict", lambda *_args, **_kwargs: (frequency, confidence)
    )
    monkeypatch.setattr(pitch_worker.torchcrepe.filter, "median", lambda value, _: value)
    return tuple(decode_pitch(point) for point in pitch_worker.pitch(None)["points"])


@pytest.mark.parametrize("silent", [True, False])
def test_actual_silence_and_pitch_dropout_with_continuing_audio_are_distinct(
    monkeypatch, silent: bool
) -> None:
    points = stabilize_pitch(_audio_evidenced_points(monkeypatch, silent=silent))
    document = construct_document(
        "t", "a", 1.0, "la", [WordTiming("la", 0.0, 1.0, 0.9)], points, _music()
    )
    notes = document.words[0].notes
    assert len(notes) == (2 if silent else 1)
    if silent:
        assert notes[0].end < 0.44 < notes[1].start
    else:
        assert notes[0].start == 0.0
        assert notes[0].end == 1.0


def test_note_smoothing_cannot_absorb_a_brief_note_across_an_unobserved_gap() -> None:
    points = _pitch([i / 100 for i in range(30)], _A4) + _pitch(
        [i / 100 for i in range(80, 85)], _C5
    )
    document = construct_document(
        "t", "a", 1.0, "la", [WordTiming("la", 0.0, 1.0, 0.9)], points, _music()
    )
    assert [note.note for note in document.words[0].notes] == [69, 72]
    assert document.words[0].notes[0].end <= 0.3 + 1e-9


def test_long_melisma_preserves_every_sustained_note_without_a_word_duration_cap() -> None:
    points = [
        PitchPoint(i / 100, frequency, 0.9)
        for first, last, frequency in [(0, 200, _A4), (200, 400, _C5), (400, 600, _A4)]
        for i in range(first, last)
    ]
    document = construct_document(
        "t", "a", 6.0, "la", [WordTiming("la", 0.0, 6.0, 0.9)], points, _music()
    )
    assert [note.note for note in document.words[0].notes] == [69, 72, 69]
    assert document.words[0].notes[-1].end == 6.0


def test_a_clean_fast_ornament_is_not_erased_only_because_it_lasts_100_ms() -> None:
    document = construct_document(
        "t", "a", 1.0, "la", [WordTiming("la", 0.0, 0.42, 0.9)], _ornament(10), _music()
    )
    assert [note.note for note in document.words[0].notes] == [69, 72, 69]


@pytest.mark.parametrize("step", [0.01, 0.02])
def test_pitch_frame_cadence_does_not_change_a_sustained_fast_transition(step) -> None:
    points = [
        PitchPoint(i * step, 880.0 if 0.12 <= i * step < 0.22 else _A4, 0.9)
        for i in range(round(0.42 / step))
    ]
    document = construct_document(
        "t", "a", 1.0, "la", [WordTiming("la", 0.0, 0.42, 0.9)], points, _music()
    )
    assert [note.note for note in document.words[0].notes] == [69, 81, 69]


def test_octave_stabilization_does_not_borrow_pitch_context_across_a_missing_time_span() -> None:
    points = [*_pitch([0.0, 0.01], _A4), *_pitch([5.0], 880.0)]
    assert stabilize_pitch(points)[-1].frequency == pytest.approx(880.0)


def test_a_legacy_provider_without_activity_does_not_fill_its_low_confidence_hole() -> None:
    points = [PitchPoint(i / 100, _A4, 0.0 if 40 <= i < 48 else 0.9) for i in range(100)]
    document = construct_document(
        "t",
        "a",
        1.0,
        "la",
        [WordTiming("la", 0.0, 1.0, 0.9)],
        stabilize_pitch(points),
        _music(),
    )
    notes = document.words[0].notes
    assert len(notes) == 2
    assert notes[0].end == pytest.approx(0.4)
    assert notes[1].start == pytest.approx(0.48)


@pytest.mark.parametrize(
    "activity,expected",
    [
        ([], ()),
        ([None, None], ("PitchActivityUnavailable:frames=2;unobservedGapsNotBridged",)),
        ([True, False], ()),
        ([None, True], ("PitchActivityUnavailable:frames=1;unobservedGapsNotBridged",)),
    ],
)
def test_legacy_pitch_activity_uncertainty_is_visible_in_technical_diagnostics(activity, expected):
    points = [PitchPoint(index / 100, _A4, 0.9, active) for index, active in enumerate(activity)]
    assert processing_reporting.pitch_warnings(points) == expected


@pytest.mark.parametrize("pitches", [(60, 62, 64), (64, 62, 60)])
def test_a_clean_fast_middle_plateau_is_preserved_in_a_monotonic_melisma(pitches) -> None:
    points = [
        PitchPoint(i / 100, 440.0 * 2 ** ((note - 69) / 12), 0.9)
        for first, last, note in [(0, 30, pitches[0]), (30, 40, pitches[1]), (40, 80, pitches[2])]
        for i in range(first, last)
    ]
    document = construct_document(
        "t", "a", 0.8, "la", [WordTiming("la", 0.0, 0.8, 0.9)], points, _music()
    )
    notes = document.words[0].notes
    assert [note.note for note in notes] == list(pitches)
    assert notes[1].start == pytest.approx(0.3)
    assert notes[1].end == pytest.approx(0.4)


def test_a_continuous_short_glide_is_not_converted_into_distinct_middle_holds() -> None:
    # There is no stable middle plateau: the contour passes continuously from C4 to D4 over100ms.
    pitches = [60.0] * 30 + [60 + i / 5 for i in range(10)] + [62.0] * 40
    points = [
        PitchPoint(i / 100, 440.0 * 2 ** ((note - 69) / 12), 0.9) for i, note in enumerate(pitches)
    ]
    document = construct_document(
        "t", "a", 0.8, "la", [WordTiming("la", 0.0, 0.8, 0.9)], points, _music()
    )
    assert [note.note for note in document.words[0].notes] == [60, 62]
