from __future__ import annotations

import numpy as np
import pytest

from backend.ai_worker.ctc import (
    AlignedWord,
    _filled_letters,
    _placed,
    with_sung_ends,
    with_voice_onsets,
)
from backend.ai_worker.timing import voiced_frames
from backend.lyrics.codec import decode_document, encode_document
from backend.lyrics.domain import LyricsDocument, Word

_RATE = 16_000
_HOP = 160
_STEP = _HOP / _RATE


def _signal(bursts: list[tuple[float, float]], total: float) -> np.ndarray:
    samples = np.zeros(int(total * _RATE), dtype=np.float32)
    rng = np.random.default_rng(1)
    for start, end in bursts:
        first, last = int(start * _RATE), int(end * _RATE)
        samples[first:last] = 0.4 * rng.standard_normal(last - first).astype(np.float32)
    return samples


def test_voiced_frames_follow_the_sound_and_ignore_a_silent_intro() -> None:
    voiced = voiced_frames(_signal([(4.0, 6.0)], 8.0), _RATE, _HOP)

    assert not voiced[: int(3.9 / _STEP)].any()
    assert voiced[int(4.2 / _STEP) : int(5.8 / _STEP)].all()
    assert not voiced[int(6.3 / _STEP) :].any()


def test_a_character_without_a_sound_starts_with_the_next_one() -> None:
    assert _filled_letters([1.0, None, 2.0, None], end=3.0) == (1.0, 2.0, 2.0, 3.0)


def test_a_word_with_nothing_to_pronounce_sits_between_its_neighbours() -> None:
    before = AlignedWord("а", 1.0, 2.0, (1.0,))
    after = AlignedWord("б", 3.0, 4.0, (3.0,))

    placed = _placed([before, None, after], ["а", "-", "б"])

    assert placed[1].text == "-"
    assert 2.0 <= placed[1].start <= placed[1].end <= 3.0 + 0.05


def test_a_held_vowel_stretches_its_word_to_the_end_of_the_sound() -> None:
    # "друг" is recognised at 1.0-1.3 s but the voice holds until 3.0 s; the next word starts at 3.5 s.
    words = [
        AlignedWord("друг", 1.0, 1.3, (1.0, 1.1, 1.2, 1.29)),
        AlignedWord("мой", 3.5, 3.8, (3.5, 3.6, 3.7)),
    ]

    stretched = with_sung_ends(words, _signal([(1.0, 3.0), (3.5, 3.9)], 5.0))

    assert stretched[0].end == pytest.approx(3.0, abs=0.1)
    assert stretched[0].letters == words[0].letters
    assert stretched[1].start == 3.5


def test_a_word_never_stretches_into_the_next_one() -> None:
    words = [AlignedWord("а", 1.0, 1.2, (1.0,)), AlignedWord("б", 2.0, 2.2, (2.0,))]

    stretched = with_sung_ends(words, _signal([(1.0, 4.0)], 5.0))

    assert stretched[0].end <= 2.0


def test_letter_timings_survive_saving_and_are_validated() -> None:
    word = Word("друг", 1.0, 3.0, (), (1.0, 1.2, 1.4, 2.9))
    document = LyricsDocument("t", "a", 10.0, None, None, "друг", (word,))

    assert decode_document(encode_document(document)).words[0].letters == (1.0, 1.2, 1.4, 2.9)
    with pytest.raises(ValueError, match="every character"):
        Word("друг", 1.0, 3.0, (), (1.0, 1.2)).validate()
    with pytest.raises(ValueError, match="backwards"):
        Word("др", 1.0, 3.0, (), (2.0, 1.5)).validate()


def test_a_word_after_a_pause_starts_when_the_voice_starts() -> None:
    # The voice starts at 2.0 s and 4.0 s; the model marked the words 0.2 s late.
    words = [
        AlignedWord("раз", 2.2, 2.8, (2.2, 2.4, 2.6)),
        AlignedWord("два", 4.2, 4.8, (4.2, 4.4, 4.6)),
    ]

    moved = with_voice_onsets(words, _signal([(2.0, 2.9), (4.0, 4.9)], 6.0))

    assert moved[0].start == pytest.approx(2.0, abs=0.06)
    assert moved[1].start == pytest.approx(4.0, abs=0.06)
    assert moved[0].letters[0] == moved[0].start
    assert moved[0].end == 2.8


def test_the_typical_lag_is_removed_from_words_inside_a_phrase() -> None:
    words = [
        AlignedWord("раз", 2.2, 2.6, (2.2, 2.4, 2.5)),
        AlignedWord("два", 2.6, 3.0, (2.6, 2.8, 2.9)),
    ]

    moved = with_voice_onsets(words, _signal([(2.0, 3.1)], 5.0))

    assert moved[0].start == pytest.approx(2.0, abs=0.06)
    assert moved[1].start == pytest.approx(2.4, abs=0.06)
    assert moved[1].start >= moved[0].start
