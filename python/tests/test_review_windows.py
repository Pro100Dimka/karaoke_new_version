from __future__ import annotations

from collections import Counter
from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, recognition, word_guidance


def _word(text: str, start: float, end: float) -> ctc.AlignedWord:
    return ctc.AlignedWord(
        text, start, end, tuple(np.linspace(start, end, len(text), endpoint=False)), 0.1
    )


def _words(text: str, count: int = 100, spacing: float = 0.8) -> list[ctc.AlignedWord]:
    return [_word(text, index * spacing, (index + 0.5) * spacing) for index in range(count)]


def _assert_local(windows: list[ctc.Window], reviewed: frozenset[int]) -> None:
    assert windows
    assert all(window.last - window.first <= 12 for window in windows)
    assert all(0 < window.end - window.start <= 8 + 1e-9 for window in windows)
    assert [index for window in windows for index in range(window.first, window.last)] == sorted(
        {index for window in windows for index in range(window.first, window.last)}
    )
    assert Counter(
        index for window in windows for index in reviewed if window.first <= index < window.last
    ) == Counter(reviewed)


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_sparse_reviews_do_not_transitively_align_almost_the_whole_song(text):
    words = _words(text)
    reviewed = frozenset(range(0, 99, 3))
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 80)
    _assert_local(windows, reviewed)
    for index in reviewed:
        owner = next(window for window in windows if window.first <= index < window.last)
        assert owner.first <= max(0, index - 1)
        assert owner.last >= min(len(words), index + 2)


def test_contiguous_complete_contexts_are_packed_under_both_budgets():
    words = _words("дом")
    reviewed = frozenset(range(0, 99, 3))
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 80)
    _assert_local(windows, reviewed)
    assert len(windows) == 11
    assert all(
        right.last - left.first > 12 or right.end - left.start > 8
        for left, right in zip(windows, windows[1:])
    )


def test_packing_does_not_fill_the_gaps_between_sparse_reviews():
    words = _words("дім")
    reviewed = frozenset(range(0, 100, 10))
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 80)
    assert len(windows) == len(reviewed)
    assert {index for window in windows for index in range(window.first, window.last)} == {
        neighbor
        for index in reviewed
        for neighbor in range(max(0, index - 1), min(len(words), index + 2))
    }


def test_packing_does_not_add_an_instrumental_gap_between_contiguous_contexts():
    words = [_word("дом", start, start + 0.25) for start in [0, 0.5, 4, 4.5, 5]]
    windows = word_guidance._review_windows(words, {}, frozenset({0, 3}), 0.6, 6)
    assert len(windows) == 2
    assert windows[0].last == windows[1].first
    assert windows[0].end < windows[1].start


def test_packing_preserves_chosen_acoustic_splits_even_when_the_parts_could_fit_together():
    words = _words("дом", count=30, spacing=0.5)
    activity = np.ones(1500, dtype=bool)
    activity[125:150] = False
    windows = word_guidance._review_windows(
        words, {}, frozenset(range(30)), 0.6, 15, voiced=activity, onsets=[3]
    )
    assert [window.last for window in windows[:2]] == [3, 6]


def test_a_distant_target_does_not_split_a_complete_local_review():
    words = _words("дім", count=30, spacing=0.5)
    words[11] = replace(words[11], end=20)
    activity = np.ones(2100, dtype=bool)
    activity[125:150] = False
    reviewed = frozenset({*range(11), 25})
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 21, voiced=activity)
    _assert_local(windows, reviewed)
    assert [(window.first, window.last) for window in windows] == [(0, 11), (24, 27)]


@pytest.mark.parametrize("spacing", [0.1, 1.2])
def test_dense_reviews_respect_both_word_and_audio_budgets(spacing):
    words = _words("привіт", spacing=spacing)
    reviewed = frozenset(range(len(words)))
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 100 * spacing)
    _assert_local(windows, reviewed)


def test_a_real_silent_gap_is_preferred_to_a_numerical_split():
    words = _words("дом", count=20, spacing=0.5)
    activity = np.ones(1000, dtype=bool)
    activity[375:400] = False
    windows = word_guidance._review_windows(
        words, {}, frozenset(range(20)), 0.6, 10, voiced=activity
    )
    assert windows[0].last == windows[1].first == 8
    assert windows[0].end <= windows[1].start


@pytest.mark.parametrize("evidence", ["recognized", "onset"])
def test_independently_supported_boundary_is_preferred_when_singing_is_continuous(evidence):
    words = _words("дім", count=20, spacing=0.5)
    heard = {7: (3.5, 3.75), 8: (4, 4.25)} if evidence == "recognized" else {}
    onsets = [4] if evidence == "onset" else []
    windows = word_guidance._review_windows(
        words,
        heard,
        frozenset(range(20)),
        0.6,
        10,
        voiced=np.ones(1000, dtype=bool),
        onsets=onsets,
    )
    assert windows[0].last == windows[1].first == 8


def test_a_conflicting_pair_at_the_budget_boundary_keeps_joint_context():
    words = _words("дом", count=24, spacing=0.5)
    words[11] = replace(words[11], end=6.2)
    reviewed = frozenset(range(24))
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 12)
    _assert_local(windows, reviewed)
    assert any(window.first <= 11 and window.last >= 13 for window in windows)


def test_a_single_sustained_word_is_not_clipped_to_the_audio_budget():
    words = [_word("ооо", 1, 21)]
    windows = word_guidance._review_windows(words, {}, frozenset({0}), 0.6, 22)
    assert len(windows) == 1
    assert (windows[0].first, windows[0].last) == (0, 1)
    assert windows[0].start <= 1
    assert windows[0].end >= 21


def test_a_long_context_word_does_not_expand_the_following_review():
    words = [_word("ооо", 0, 20), _word("дом", 20.2, 20.5), _word("там", 20.7, 21)]
    reviewed = frozenset({1})
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 22)
    _assert_local(windows, reviewed)
    assert windows[0].first == 1


@pytest.mark.parametrize("count,reviewed", [(0, {0}), (5, set()), (5, {-1, 5, 999})])
def test_no_valid_targets_produce_no_review_windows(count, reviewed):
    assert (
        word_guidance._review_windows(_words("дом", count), {}, frozenset(reviewed), 0.6, 8) == []
    )


def test_invalid_target_indices_do_not_discard_valid_reviews():
    windows = word_guidance._review_windows(
        _words("дім", 5), {}, frozenset({-1, 0, 3, 5, 999}), 0.6, 8
    )
    _assert_local(windows, frozenset({0, 3}))


def test_padded_recognition_cannot_repeat_audio_across_distant_reviews():
    words = _words("дом", count=10, spacing=1)
    windows = word_guidance._review_windows(
        words, {1: (1, 6), 6: (3, 6.5)}, frozenset({0, 7}), 0.6, 10
    )
    assert len(windows) == 2
    assert windows[0].end <= words[2].start
    assert windows[1].start >= words[5].end
    assert windows[0].end <= windows[1].start


@pytest.mark.parametrize("text", ["дорога", "доріжка"])
def test_each_review_target_reuses_the_cached_emission_only_once(monkeypatch, text):
    words = _words(text)
    reviewed = frozenset(range(len(words)))
    calls = []
    scores = torch.zeros(4000, 28)

    def align(source, _step, text, window):
        assert source is scores
        assert text == [word.text for word in words[window.first : window.last]]
        calls.append(window)
        return words[window.first : window.last]

    monkeypatch.setattr(ctc, "_align_window", align)
    result = word_guidance._reviewed_words(
        words, scores, 0.02, {}, np.ones(8000, dtype=bool), 0.6, reviewed
    )
    _assert_local(calls, reviewed)
    assert all(left.end <= right.start for left, right in zip(calls, calls[1:]))
    assert result == words


def test_an_accepted_local_candidate_cannot_cross_an_outside_neighbor(monkeypatch):
    words = _words("дом", count=24, spacing=0.5)
    reviewed = frozenset(range(24))

    def align(_source, _step, _text, window):
        candidates = words[window.first : window.last]
        if window.last < len(words):
            candidates[-1] = replace(candidates[-1], end=words[window.last].start + 0.1, score=0.99)
        return candidates

    monkeypatch.setattr(ctc, "_align_window", align)
    result = word_guidance._reviewed_words(
        words, torch.zeros(600, 28), 0.02, {}, np.ones(1200, dtype=bool), 0.6, reviewed
    )
    assert result == words


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_real_ctc_recovers_both_sides_of_a_conflict_near_a_split(monkeypatch, text):
    actual = [
        ctc.AlignedWord(
            text if index % 2 else "там",
            start := 0.1 + index * 0.5,
            start + 0.32,
            (start, start + 0.1, start + 0.3),
            0.99,
        )
        for index in range(24)
    ]
    words = [replace(word, score=0.1) for word in actual]
    words[11] = replace(words[11], end=6.3, letters=(5.6, 5.7, 6.28))
    words[12] = replace(words[12], start=5.9, letters=(5.9, 6.2, 6.4))
    scores = torch.full((625, 28), float(np.log(1e-6)))
    scores[:, 0] = float(np.log(0.99))
    for word in actual:
        for at, tokens in zip(word.letters, ctc._character_tokens(word.text), strict=True):
            for offset, token in enumerate(tokens):
                frame = round(at / 0.02) + offset
                scores[frame, 0] = float(np.log(0.01))
                scores[frame, token] = float(np.log(0.99))
    calls = []
    align = ctc._align_window

    def measured_align(source, step, text, window):
        assert source is scores
        calls.append(window)
        return align(source, step, text, window)

    monkeypatch.setattr(ctc, "_align_window", measured_align)
    reviewed = frozenset(range(24))
    result = word_guidance._reviewed_words(
        words,
        scores,
        0.02,
        {index: (word.start, word.end) for index, word in enumerate(actual)},
        np.ones(1250, dtype=bool),
        0.6,
        reviewed,
    )
    _assert_local(calls, reviewed)
    assert any(window.first <= 11 and window.last >= 13 for window in calls)
    assert [word.text for word in result] == [word.text for word in actual]
    np.testing.assert_allclose(
        [(word.start, word.end) for word in result],
        [(word.start, word.end) for word in actual],
        atol=0.02,
        rtol=0,
    )
    assert all(left.end <= right.start for left, right in zip(result, result[1:]))


def test_an_unavoidable_uncertain_seam_keeps_diagnostics_and_attempts_every_target(monkeypatch):
    words = [
        replace(_word("дом", index * 0.1, index * 0.1 + 0.25), diagnostics=("BoundaryConflict",))
        for index in range(30)
    ]
    calls = []

    def align(_source, _step, _text, window):
        calls.append(window)
        return [
            replace(word, end=word.start + 0.05, score=0.99, diagnostics=())
            for word in words[window.first : window.last]
        ]

    monkeypatch.setattr(ctc, "_align_window", align)
    reviewed = frozenset(range(30))
    result = word_guidance._reviewed_words(
        words, torch.zeros(200, 28), 0.02, {}, np.ones(400, dtype=bool), 0.6, reviewed
    )
    _assert_local(calls, reviewed)
    assert all(left.end <= right.start for left, right in zip(calls, calls[1:]))
    assert result == words


def test_coincident_cores_without_separate_audio_remain_diagnosed_through_export(monkeypatch):
    words = [_word("дом", 1, 2) for _ in range(30)]
    reviewed = frozenset(range(30))
    windows = word_guidance._review_windows(words, {}, reviewed, 0.6, 3)
    assert Counter(
        index for window in windows for index in range(window.first, window.last)
    ) == Counter(reviewed)
    assert all(window.last - window.first <= 12 for window in windows)
    assert all(left.end <= right.start for left, right in zip(windows, windows[1:]))
    assert any(window.start == window.end for window in windows)

    def align(_source, _step, _text, window):
        assert window.start < window.end
        return [replace(word, score=0.99) for word in words[window.first : window.last]]

    monkeypatch.setattr(ctc, "_align_window", align)
    result = word_guidance._reviewed_words(
        words, torch.zeros(150, 28), 0.02, {}, np.ones(300, dtype=bool), 0.6, reviewed
    )
    assert result == words
    ordered = ctc.ordered(result)
    outstanding = recognition.rate_review_indices(ordered, " ".join(word.text for word in words))
    payload = recognition.alignment_payload(ordered, {}, reviewed=frozenset(outstanding))["words"]
    assert all("BoundaryConflict" in word["diagnostics"] for word in payload)
    assert all("TimingReviewRequired" in word["diagnostics"] for word in payload)
