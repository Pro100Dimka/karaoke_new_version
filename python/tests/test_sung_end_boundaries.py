from __future__ import annotations

import numpy as np
import pytest

from backend.ai.domain import PitchPoint, WordTiming
from backend.ai_worker import ctc
from backend.processing.algorithms import MusicMetadata, construct_document


def _case(seam: float = 2.0, *, pause: bool = False):
    rate = 16000
    axis = np.arange(4 * rate) / rate
    samples = np.sin(2 * np.pi * 220 * axis).astype(np.float32)
    if pause:
        samples[round(1.6 * rate) : 2 * rate] = 0
    words = [
        ctc.AlignedWord("я", 1.0, 1.2, (1.0,), 0.9),
        ctc.AlignedWord("один", seam, 2.5, (seam, 2.1, 2.3, 2.4), 0.9),
    ]
    return words, samples, ctc.voiced_frames(samples, rate, 160)


@pytest.mark.parametrize("seam", [2.0, 2.005])
def test_continuing_singing_reaches_the_next_word_at_or_between_activity_frames(seam):
    words, samples, activity = _case(seam)
    assert activity[195:203].all()

    result = ctc.with_sung_ends(words, samples, voiced=activity)

    assert result[0].end == result[1].start == seam
    assert result[0].start == words[0].start
    assert [word.letters for word in result] == [word.letters for word in words]


@pytest.mark.parametrize("silence,expected", [("recorded_pause", 1.61), ("last_hop", 1.99)])
def test_a_silent_frame_still_stops_singing_before_the_next_word(silence, expected):
    words, samples, activity = _case(pause=silence == "recorded_pause")
    if silence == "last_hop":
        activity[199] = False

    result = ctc.with_sung_ends(words, samples, voiced=activity)

    # RMS windows are centered: the first fully silent center after 1.60 is 1.61.
    assert result[0].end == expected
    assert result[0].end < result[1].start
    assert [word.letters for word in result] == [word.letters for word in words]


def test_silence_clipping_marks_redistributed_letters_as_approximate():
    rate = 16000
    axis = np.arange(2 * rate) / rate
    samples = (0.2 * np.sin(2 * np.pi * 220 * axis) * ((axis >= 0.2) & (axis < 0.6))).astype(
        np.float32
    )
    word = ctc.AlignedWord("мрія", 0.2, 1.3, (0.2, 0.4, 1.0, 1.2), 0.9)
    result = ctc.with_sung_ends([word], samples)[0]
    assert result.end < 0.65
    assert result.letters != word.letters
    assert "ApproximateLetterTiming" in result.diagnostics
    assert "LetterTimingReviewRequired" in result.diagnostics


@pytest.mark.parametrize("text", ["аня", "мрія"])
def test_sung_end_does_not_bridge_a_release_into_a_later_breath(text):
    rate = 16000
    axis = np.arange(3 * rate) / rate
    samples = (0.2 * np.sin(2 * np.pi * 220 * axis)).astype(np.float32)
    samples[(axis < 1) | (axis >= 2)] = 0
    breath = (axis >= 2.11) & (axis < 2.6)
    samples[breath] = np.random.default_rng(7).normal(0, 0.08, int(breath.sum()))
    word = ctc.AlignedWord(text, 1, 1.9, (1,) * len(text), 0.9)

    result = ctc.with_sung_ends([word], samples)[0]

    # The phrase-activity mask bridges this 110-ms gap. It cannot authorize
    # extending the already finished vowel into the next audible event.
    assert 2 <= result.end <= 2.02
    assert (result.start, result.letters) == (word.start, word.letters)


@pytest.mark.parametrize("echo_frequency", [220, 330])
def test_a_pitched_echo_after_a_real_pause_cannot_continue_a_released_vowel(echo_frequency):
    rate = 16000
    axis = np.arange(3 * rate) / rate
    samples = np.zeros(len(axis), dtype=np.float32)
    sung = (axis >= 1) & (axis < 2)
    echo = (axis >= 2.11) & (axis < 2.6)
    samples[sung] = 0.2 * np.sin(2 * np.pi * 220 * axis[sung])
    samples[echo] = 0.08 * np.sin(2 * np.pi * echo_frequency * axis[echo])
    word = ctc.AlignedWord("мрія", 1, 1.9, (1, 1.2, 1.4, 1.6), 0.9)

    result = ctc.with_sung_ends([word], samples)[0]

    # Centered 128-ms FFT windows can contain harmonics from both sides of this
    # silent gap. Those adjacent sounds do not prove periodic singing in the gap.
    assert 2 <= result.end <= 2.02
    assert (result.start, result.letters) == (word.start, word.letters)


def test_a_brief_closure_inside_a_confirmed_word_is_not_a_release():
    words, samples, activity = _case()
    samples[round(1.3 * 16000) : round(1.41 * 16000)] = 0
    word = ctc.AlignedWord("одна", 1, 1.8, (1, 1.4, 1.5, 1.6), 0.9)

    result = ctc.with_sung_ends([word, words[1]], samples)[0]

    assert result.end == words[1].start


@pytest.mark.parametrize("text", ["лист", "світ"])
def test_a_quiet_final_stop_release_is_not_lost_after_letter_onset_calibration(text):
    rate = 16000
    axis = np.arange(3 * rate) / rate
    samples = np.zeros(len(axis), dtype=np.float32)
    vowel = (axis >= 1) & (axis < 1.75)
    fricative = (axis >= 1.75) & (axis < 1.83)
    release = (axis >= 1.87) & (axis < 1.9)
    samples[vowel] = 0.2 * np.sin(2 * np.pi * 220 * axis[vowel])
    noise = np.random.default_rng(23)
    samples[fricative] = noise.normal(0, 0.003, int(fricative.sum()))
    samples[release] = noise.normal(0, 0.08, int(release.sum()))
    # Word-wide onset calibration can put the last letter inside the vowel,
    # although the unshifted CTC endpoint reaches the final stop's closure.
    word = ctc.AlignedWord(text, 1, 1.86, (1, 1.41, 1.57, 1.65), 0.9)

    result = ctc.with_sung_ends([word], samples)[0]

    assert 1.9 <= result.end <= 1.92
    assert (result.start, result.letters) == (word.start, word.letters)


@pytest.mark.parametrize("voiced_tail", [True, False])
def test_quiet_continuation_after_the_ctc_core_is_not_a_release(voiced_tail):
    rate = 16000
    axis = np.arange(4 * rate) / rate
    carrier = np.sin(2 * np.pi * 220 * axis) + 0.25 * np.sin(2 * np.pi * 440 * axis)
    if not voiced_tail:
        carrier[axis >= 1.4] = np.random.default_rng(11).normal(0, 0.5, int((axis >= 1.4).sum()))
    amplitude = np.where((axis >= 1) & (axis < 3), 0.2, 0.0)
    amplitude[(axis >= 1.8) & (axis < 1.89)] = 0.001
    samples = (carrier * amplitude).astype(np.float32)
    word = ctc.AlignedWord(
        "ма" if voiced_tail else "нас", 1, 1.5, (1, 1.4) if voiced_tail else (1, 1.2, 1.4), 0.9
    )

    result = ctc.with_sung_ends([word], samples)[0]

    assert 3 <= result.end <= 3.02


@pytest.mark.parametrize(
    "mode,quiet_amplitude,harmonic",
    [
        ("low_65hz", 0.001, 0.3),
        ("note_change", 0.001, 0.3),
        ("glissando", 0.001, 0.3),
        ("vibrato", 0.001, 0.3),
        ("fast_glissando", 0.003, 0.25),
    ],
)
def test_a_quiet_melisma_after_the_ctc_core_keeps_its_performed_end(
    mode, quiet_amplitude, harmonic
):
    rate = 16000
    axis = np.arange(4 * rate) / rate
    if mode == "low_65hz":
        frequency = np.full_like(axis, 65.0)
    elif mode == "note_change":
        frequency = np.where(axis < 1.845, 220.0, 330.0)
    elif mode == "glissando":
        frequency = 180 + 140 * np.clip((axis - 1.8) / 0.09, 0, 1)
    elif mode == "fast_glissando":
        frequency = 220 + 440 * np.clip((axis - 1.8) / 0.09, 0, 1)
    else:
        frequency = 220 + 12 * np.sin(2 * np.pi * 6 * axis)
    phase = 2 * np.pi * np.cumsum(frequency) / rate
    amplitude = np.where((axis >= 1) & (axis < 3), 0.2, 0.0)
    # The voice remains periodic through this quieter section, including when
    # its note changes. There is no silence, breath or separate word here.
    amplitude[(axis >= 1.8) & (axis < 1.89)] = quiet_amplitude
    samples = (amplitude * (np.sin(phase) + harmonic * np.sin(2 * phase))).astype(np.float32)
    word = ctc.AlignedWord("ма", 1, 1.5, (1, 1.4), 0.9)

    result = ctc.with_sung_ends([word], samples)[0]

    assert result.end == pytest.approx(3.0, abs=0.02)
    assert (result.start, result.letters) == (word.start, word.letters)


@pytest.mark.parametrize("seam", [2.0, 2.005])
def test_one_global_note_stays_continuous_when_intersected_with_refined_words(seam):
    words, samples, activity = _case(seam)
    refined = ctc.with_sung_ends(words, samples, voiced=activity)
    timings = [
        WordTiming(word.text, word.start, word.end, word.score, word.letters) for word in refined
    ]
    points = [PitchPoint(index / 100, 220, 0.99, True) for index in range(100, 250)]
    music = MusicMetadata(None, None)
    whole = construct_document("t", "a", 4, "а", [WordTiming("а", 1, 4, 1)], points, music)
    document = construct_document("t", "a", 4, "я один", timings, points, music)
    global_note = whole.words[0].notes[0]
    assert len(whole.words[0].notes) == 1
    assert [len(word.notes) for word in document.words] == [1, 1]
    pieces = [word.notes[0] for word in document.words]

    assert pieces[0].end == pieces[1].start == seam
    assert sum(note.end - note.start for note in pieces) == pytest.approx(
        global_note.end - global_note.start
    )
    assert all(
        pitch is not None and active
        for time, pitch, active in document.target_frames(step=0.005)
        if 1.9 <= time < 2.1
    )
    for word, note in zip(document.words, pieces, strict=True):
        assert (note.start, note.end) == (
            max(global_note.start, word.start),
            min(global_note.end, word.end),
        )
        assert note.note == global_note.note
        measured = [
            note.start + fraction * (note.end - note.start) for fraction, _, _ in note.contour
        ]
        assert measured == pytest.approx(
            [point.time for point in points if note.start <= point.time < note.end]
        )
