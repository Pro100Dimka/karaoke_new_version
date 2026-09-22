from __future__ import annotations

import numpy as np
import pytest

from backend.ai_worker.ctc import (
    AlignedWord,
    _filled_letters,
    _placed,
    _spread_tied_letters,
    ordered,
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


def test_a_fast_consonant_cluster_on_the_same_frame_is_spread_across_the_gap() -> None:
    # "м" and "у" both land on 4.43 (same model frame); the next distinct sounded character is at 4.63.
    spread = _spread_tied_letters([4.43, 4.43, 4.63], end=5.0)

    assert spread == pytest.approx([4.43, 4.53, 4.63])


def test_a_tied_run_at_the_end_of_a_word_spreads_to_the_word_end() -> None:
    spread = _spread_tied_letters([1.0, 2.0, 2.0, 2.0], end=2.6)

    assert spread == [1.0, 2.0, pytest.approx(2.2), pytest.approx(2.4)]


def test_silent_characters_are_not_touched_by_spreading() -> None:
    # A tie at index 0-1 spreads; the None at index 2 is left for _filled_letters to assign later.
    spread = _spread_tied_letters([1.0, 1.0, None, 2.0], end=3.0)

    assert spread == [1.0, pytest.approx(1.5), None, 2.0]


def test_genuinely_distinct_letters_are_left_alone() -> None:
    assert _spread_tied_letters([1.0, 1.2, 1.5], end=2.0) == [1.0, 1.2, 1.5]


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


def test_text_is_split_into_stretches_pinned_to_where_whisper_heard_it() -> None:
    from backend.ai_worker.speech import _windows

    words = "раз два три четыре пять шесть семь восемь".split()
    heard = [
        ("раз", 10.0, 10.5),
        ("два", 10.5, 11.0),
        ("три", 11.0, 11.5),
        ("семь", 30.0, 30.5),
        ("восемь", 30.5, 31.0),
        ("х", 31.0, 31.2),
    ]

    windows = _windows(words, heard, total=60.0)

    pinned = [window for window in windows if window.last - window.first >= 3]
    assert (pinned[0].first, pinned[0].last) == (0, 3)
    assert pinned[0].start == pytest.approx(9.4) and pinned[0].end == pytest.approx(12.1)
    assert [(window.first, window.last) for window in windows][-1][1] == len(words)
    # Words nobody heard (четыре, пять, шесть) share the audio between the two heard stretches.
    gap = next(window for window in windows if window.first == 3)
    assert gap.start == pytest.approx(12.1) and gap.end >= 12.1


def test_without_any_recognised_run_the_whole_song_is_one_stretch() -> None:
    from backend.ai_worker.speech import _windows

    windows = _windows(["раз", "два", "три"], [("х", 1.0, 2.0)], total=30.0)

    assert [(window.first, window.last, window.start, window.end) for window in windows] == [
        (0, 3, 0.0, 30.0)
    ]


def test_words_from_overlapping_windows_end_up_ordered_and_with_positive_length() -> None:
    words = [
        AlignedWord("а", 5.0, 5.4, (5.0,)),
        AlignedWord(
            "б", 4.0, 4.5, (4.0,)
        ),  # a neighbouring window placed this word before the previous one
        AlignedWord("в", 6.0, 6.0, (6.0,)),
    ]

    fixed = ordered(words)

    assert [word.start for word in fixed] == sorted(word.start for word in fixed)
    assert all(word.end > word.start for word in fixed)
    assert all(word.start <= moment <= word.end for word in fixed for moment in word.letters)


def test_ordered_spreads_letters_pushed_later_instead_of_collapsing_them() -> None:
    # The previous word ends at 8.13, right where this word's own first two letters were recognised
    # ("м","а" tied on the same model frame); ordered() must push the word's start to 8.13 without
    # collapsing those two letters onto that single new start.
    words = [
        AlignedWord("город", 7.62, 8.13, (7.62, 7.7, 7.8, 7.9, 8.0)),
        AlignedWord("магистрали", 8.1, 9.1, (8.1, 8.1, 8.2, 8.3)),
    ]

    fixed = ordered(words)

    assert fixed[1].start == pytest.approx(8.13)
    assert fixed[1].letters[0] == pytest.approx(8.13)
    assert fixed[1].letters[1] > fixed[1].letters[0]


def test_ordered_never_leaves_two_words_overlapping() -> None:
    # "б" was placed by a neighbouring window before "а" ends; with_voice_onsets can also pull a start
    # earlier than the previous word's (already fixed) end. Either way, ordered() is the last safety net.
    words = [
        AlignedWord("а", 5.0, 5.4, (5.0,)),
        AlignedWord("б", 4.0, 4.5, (4.0,)),
        AlignedWord("в", 6.0, 6.0, (6.0,)),
    ]

    fixed = ordered(words)

    for earlier, later in zip(fixed, fixed[1:]):
        assert earlier.end <= later.start


def test_moving_a_start_back_never_puts_a_word_before_the_previous_one() -> None:
    # The second word ends before the first one starts: the correction must still keep them in order.
    words = [
        AlignedWord("раз", 4.0, 5.0, (4.0, 4.3, 4.6)),
        AlignedWord("два", 3.0, 3.5, (3.0, 3.2, 3.4)),
    ]

    moved = with_voice_onsets(words, _signal([(2.5, 5.2)], 7.0))

    assert moved[0].start <= moved[1].start
    assert all(word.end > word.start for word in moved)
