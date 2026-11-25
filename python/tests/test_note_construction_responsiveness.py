import math
from dataclasses import replace

import pytest

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.domain import LyricsDocument
from backend.processing import algorithms


def _legacy_document(words, pitch, duration):
    """The pre-indexing orchestration, retaining its full scans as an output reference."""
    lyrics = " ".join(word.text for word in words)
    music = algorithms.MusicMetadata(100, "A")
    melody = algorithms._notes_from_points(pitch, 0.0, duration)
    performed = tuple(word for word in words if "BackingVocalOverlap" not in word.diagnostics)
    mapped = tuple(algorithms._word_with_notes(word, pitch, melody) for word in performed)
    activity = algorithms._vocal_activity(
        [
            point
            for point in pitch
            if any(word.start <= point.time < word.end for word in performed)
        ],
        duration,
    )
    document = LyricsDocument(
        "title",
        "artist",
        duration,
        music.bpm,
        music.key,
        algorithms._phrase_lines(lyrics, words, activity, music.bpm),
        mapped,
        activity,
    )
    document.validate()
    return document


def _document(words, pitch, duration):
    return algorithms.construct_document(
        "title",
        "artist",
        duration,
        " ".join(word.text for word in words),
        words,
        pitch,
        algorithms.MusicMetadata(100, "A"),
    )


def _song(word_count):
    words = tuple(WordTiming(f"w{i}", i * 0.3, i * 0.3 + 0.24, 1) for i in range(word_count))
    pitch = tuple(PitchPoint(i / 100, 440, 1, True) for i in range(word_count * 30))
    return words, pitch, word_count * 0.3


class _CountedTime(float):
    def __new__(cls, value, comparisons):
        result = super().__new__(cls, value)
        result.comparisons = comparisons
        return result

    def __lt__(self, other):
        self.comparisons[0] += 1
        return super().__lt__(other)

    def __le__(self, other):
        self.comparisons[0] += 1
        return super().__le__(other)

    def __gt__(self, other):
        self.comparisons[0] += 1
        return super().__gt__(other)

    def __ge__(self, other):
        self.comparisons[0] += 1
        return super().__ge__(other)


def test_constructing_notes_does_not_compare_every_frame_with_every_word():
    words, pitch, duration = _song(100)
    comparisons = [0]
    measured_words = tuple(
        replace(
            word,
            start=_CountedTime(word.start, comparisons),
            end=_CountedTime(word.end, comparisons),
        )
        for word in words
    )
    result = _document(measured_words, pitch, duration)
    assert len(result.words) == len(words)
    assert comparisons[0] <= 30 * (len(pitch) + len(words)), (
        f"Document construction performed {comparisons[0]} word-boundary comparisons for "
        f"{len(pitch)} frames and {len(words)} words"
    )


def test_five_minute_song_keeps_every_note_contour_word_and_activity_interval():
    words, pitch, duration = _song(1000)
    pitch = tuple(
        replace(
            point,
            frequency=440 * 2 ** (((index // 75) % 5 + 0.3 * math.sin(index / 3)) / 12),
            confidence=0.2 if index % 137 == 0 else 0.95,
            audio_active=index % 300 < 250,
        )
        for index, point in enumerate(pitch)
    )
    assert _document(words, pitch, duration) == _legacy_document(words, pitch, duration)


@pytest.mark.parametrize(
    "case",
    [
        "boundaries",
        "empty-pitch",
        "no-words",
        "backing-only",
        "overlap",
        "duplicate-timestamps",
        "unordered-outside-words",
    ],
)
def test_pitch_indexing_preserves_existing_boundary_and_overlap_behavior(case):
    words = (
        WordTiming("a", 0.0, 0.3, 1, (0.0,)),
        WordTiming("b", 0.3, 0.5, 1, (0.3,), ("ApproximateLetterTiming",)),
        WordTiming("c", 0.6, 0.8, 1, (0.6,)),
    )
    pitch = tuple(PitchPoint(i / 100, 440, 1, True) for i in range(100))
    if case == "empty-pitch":
        pitch = ()
    elif case == "no-words":
        words = ()
    elif case == "backing-only":
        words = tuple(replace(word, diagnostics=("BackingVocalOverlap",)) for word in words)
    elif case == "overlap":
        # The first word remains active after the following shorter, nested word ends.
        words = (replace(words[0], end=0.7), replace(words[1], start=0.2), words[2])
    elif case == "duplicate-timestamps":
        pitch = (*pitch[:31], replace(pitch[30], frequency=466, confidence=0.7), *pitch[31:])
    elif case == "unordered-outside-words":
        pitch = (pitch[0], replace(pitch[-1], frequency=0, audio_active=False), *pitch[1:-1])
    assert _document(words, pitch, 1.0) == _legacy_document(words, pitch, 1.0)
