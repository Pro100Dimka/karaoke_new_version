from __future__ import annotations

import pytest

from backend.ai.domain import PitchPoint, WordTiming
from backend.processing.algorithms import refine_words


def _pitch(times: list[float]) -> list[PitchPoint]:
    return [PitchPoint(time, 220.0, 0.9) for time in times]


def test_narrowing_to_pitch_does_not_collapse_opening_letters_onto_one_instant() -> None:
    # The word was recognised over 10.0-11.0 s, but pitch was only actually detected from 10.3 s;
    # clamping each letter independently to the new, later start would put the first two on top of
    # each other instead of keeping the highlight moving through both.
    word = WordTiming("бой", 10.0, 11.0, 1.0, (10.0, 10.05, 10.6))

    refined = refine_words([word], _pitch([10.3, 10.4, 10.5, 10.6, 10.7]))

    letters = refined[0].letters
    assert len(letters) == 3
    assert len(set(letters)) == len(letters), "every letter should get a distinct moment"
    assert list(letters) == sorted(letters)
    assert refined[0].start == letters[0]


def test_narrowing_never_swallows_more_than_the_words_own_first_letter() -> None:
    # "Скрой": pitch is only detected once the vowel sounds, well after three already well-spaced
    # consonant letters ("с", "к", "р"); narrowing straight to the first pitch point would crush all
    # three into the same sliver. Only the very first letter should be absorbed into the new start.
    word = WordTiming("Скрой", 83.61, 84.11, 1.0, (83.61, 83.69, 83.79, 83.89, 84.03))

    refined = refine_words([word], _pitch([83.88, 83.95, 84.0, 84.05, 84.1]))

    letters = refined[0].letters
    # Before this guard, the pitch-detected start (83.88) would have swallowed the first three letters
    # together; now only the first two share the tightened opening, well apart from the third onward.
    assert letters[2] == pytest.approx(83.79)
    assert letters[3] == pytest.approx(83.89)
    assert letters[4] == pytest.approx(84.03)
    assert len(set(letters)) == len(letters)
    assert list(letters) == sorted(letters)


def test_narrowing_the_end_never_glues_the_last_letter_to_the_one_before_it() -> None:
    # Mirror of the start-side guard: pitch fades before the last (unvoiced) letter finishes, so a naive
    # narrow-to-pitch would clamp the last letter down onto the same instant as the second-to-last one.
    word = WordTiming("сказав.", 102.44, 105.89, 1.0, (102.44, 102.537, 102.737, 103.157, 103.297, 105.759, 105.779))

    refined = refine_words([word], _pitch([102.5, 102.7, 103.0, 103.2, 105.5, 105.7, 105.759]))

    letters = refined[0].letters
    assert letters[-1] > letters[-2]
    assert len(set(letters)) == len(letters)


def test_a_word_with_no_detected_pitch_is_left_unchanged() -> None:
    word = WordTiming("тишина", 5.0, 6.0, 1.0, (5.0, 5.2, 5.4, 5.6, 5.8, 5.9))

    refined = refine_words([word], _pitch([]))

    assert refined[0] == word


def test_the_start_backs_off_from_the_first_voiced_point_for_the_trackers_own_onset_lag() -> None:
    # A single-letter word has no letters[1] to clamp against, so the backoff is the only thing
    # deciding the new start: it should land noticeably earlier than the raw first voiced point.
    word = WordTiming("О", 5.0, 5.5, 1.0, (5.0,))

    refined = refine_words([word], _pitch([5.2, 5.3, 5.4]))

    assert refined[0].start == pytest.approx(5.15)


def test_the_backoff_never_pushes_the_start_before_the_words_own_alignment_start() -> None:
    word = WordTiming("О", 5.0, 5.5, 1.0, (5.0,))

    refined = refine_words([word], _pitch([5.02, 5.1, 5.2]))

    assert refined[0].start == pytest.approx(5.0)
