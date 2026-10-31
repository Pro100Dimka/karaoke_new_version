from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, recognition, speech, word_guidance


def _word(text: str, start: float, end: float, score: float = 0.1) -> ctc.AlignedWord:
    letters = tuple(np.linspace(start, end, len(text), endpoint=False))
    return ctc.AlignedWord(text, start, end, letters, score)


def _activity(*spans: tuple[float, float], total: float = 4) -> np.ndarray:
    result = np.zeros(round(total * 100), dtype=bool)
    for start, end in spans:
        result[round(start * 100) : round(end * 100)] = True
    return result


def _emissions(words: list[ctc.AlignedWord], total: float = 4) -> torch.Tensor:
    """Synthetic character scores for reproducible alignment tests without model weights."""
    scores = torch.full((round(total / 0.02), 28), np.log(1e-6))
    scores[:, 0] = np.log(0.99)
    for word in words:
        for at, tokens in zip(word.letters, ctc._character_tokens(word.text), strict=True):
            for offset, token in enumerate(tokens):
                frame = round(at / 0.02) + offset
                scores[frame, 0] = np.log(0.01)
                scores[frame, token] = np.log(0.99)
    return scores


@pytest.mark.parametrize(
    "text,duration", [("дом", 0.07), ("привет", 0.18), ("дім", 0.07), ("привіт", 0.18)]
)
def test_short_word_is_reviewed_when_independent_span_and_singing_disagree(text, duration):
    word = _word(text, 1, 1 + duration)
    assert recognition.rate_review_indices(
        [word], text, heard={0: (1, 2)}, activity=_activity((1, 2))
    ) == {0}


@pytest.mark.parametrize("text,duration", [("дом", 0.07), ("привіт", 0.18)])
def test_genuine_quick_word_is_not_reviewed_for_its_absolute_duration(text, duration):
    word = _word(text, 1, 1 + duration)
    assert (
        recognition.rate_review_indices(
            [word], text, heard={0: (1, 1 + duration)}, activity=_activity((1, 1 + duration))
        )
        == set()
    )


def test_recognition_padding_over_silence_is_not_missing_singing():
    word = _word("дом", 1, 1.07)
    assert (
        recognition.rate_review_indices(
            [word], word.text, heard={0: (1, 2)}, activity=_activity((1, 1.07))
        )
        == set()
    )


def test_conflicting_cores_are_reviewed_together_before_ordering():
    words = [_word("дом", 1, 2), _word("там", 1.1, 2.4)]
    assert recognition.rate_review_indices(words, "дом там") == {0, 1}


def test_review_realigns_neighboring_cores_together_from_cached_emissions():
    actual = [
        ctc.AlignedWord("дом", 1, 2, (1, 1.04, 1.98), 0.99),
        ctc.AlignedWord("там", 2.04, 2.4, (2.04, 2.12, 2.38), 0.99),
    ]
    wrong = [_word("дом", 1, 1.1), _word("там", 1.1, 2.4)]
    result = word_guidance.with_word_guidance(
        wrong,
        _emissions(actual),
        0.02,
        [ctc.Window(0, 2, 0.5, 3)],
        {i: (word.start, word.end) for i, word in enumerate(actual)},
        _activity((1, 2.4)),
        0.6,
        reviewed=frozenset({0}),
    )
    assert result[0].start == pytest.approx(1, abs=0.02)
    assert result[0].end == pytest.approx(2, abs=0.02)
    assert result[1].start == pytest.approx(2.04, abs=0.02)
    assert result[0].end <= result[1].start


def test_review_can_recover_an_acoustically_supported_word_under_eighty_milliseconds():
    actual = ctc.AlignedWord("дом", 1, 1.06, (1, 1.02, 1.04), 0.99)
    result = word_guidance.with_word_guidance(
        [_word("дом", 1, 1.1)],
        _emissions([actual]),
        0.02,
        [ctc.Window(0, 1, 0.5, 2)],
        {0: (1, 1.06)},
        _activity((1, 1.06)),
        0.6,
        reviewed=frozenset({0}),
    )
    assert result[0].end == pytest.approx(1.06, abs=0.001)


def test_review_does_not_promote_a_proportional_fallback_to_an_acoustic_repair(monkeypatch):
    original = _word("дом", 1, 1.07, 0.01)
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda _s, _step, text, window: ctc._evenly(text, window.start, window.end),
    )
    result = word_guidance.with_word_guidance(
        [original],
        torch.zeros(200, 28),
        0.02,
        [ctc.Window(0, 1, 0.5, 3)],
        {0: (1.5, 2)},
        _activity((1, 2)),
        0.6,
        reviewed=frozenset({0}),
    )
    assert result == [original]


def test_review_does_not_erase_a_conflict_by_discarding_strong_phonetic_bodies(monkeypatch):
    original = [
        ctc.AlignedWord("дом", 1, 2, (1, 1.2, 1.8), 0.9, ("BoundaryConflict",)),
        ctc.AlignedWord("там", 1.1, 2.4, (1.1, 2.1, 2.3), 0.9, ("BoundaryConflict",)),
    ]
    candidates = [_word("дом", 1, 1.2, 0.001), _word("там", 1.2, 1.4, 0.001)]
    scores = torch.full((200, 28), np.log(0.9))
    for word in original:
        scores[round(word.start / 0.02), ctc._character_tokens(word.text)[0][0]] = np.log(0.001)
    monkeypatch.setattr(ctc, "_align_window", lambda *_: candidates)
    result = word_guidance.with_word_guidance(
        original,
        scores,
        0.02,
        [ctc.Window(0, 2, 0.5, 3)],
        {},
        _activity((1, 2.4)),
        0.6,
        reviewed=frozenset({0, 1}),
    )
    assert result == original


def test_review_respects_an_independently_confirmed_voice_entry(monkeypatch):
    original = _word("дом", 1.3, 1.6, 0.3)
    candidate = _word("дом", 1, 1.6, 0.4)
    monkeypatch.setattr(ctc, "_align_window", lambda *_: [candidate])
    result = word_guidance.with_word_guidance(
        [original],
        torch.full((200, 28), np.log(0.3)),
        0.02,
        [ctc.Window(0, 1, 0.5, 2)],
        {0: (1, 1.7)},
        _activity((1, 1.7)),
        0.6,
        onsets=[1.25],
        reviewed=frozenset({0}),
    )
    assert result == [original]


def test_joint_review_does_not_shorten_an_unflagged_neighbors_confirmed_end(monkeypatch):
    original = [_word("дом", 1, 1.1), _word("там", 1.1, 2.4, 0.9)]
    candidates = [_word("дом", 1, 1.2, 0.99), _word("там", 1.2, 1.4, 0.99)]
    monkeypatch.setattr(ctc, "_align_window", lambda *_: candidates)
    result = word_guidance.with_word_guidance(
        original,
        torch.full((200, 28), np.log(0.9)),
        0.02,
        [ctc.Window(0, 2, 0.5, 3)],
        {0: (1, 1.2)},
        _activity((1, 2.4)),
        0.6,
        reviewed=frozenset({0}),
    )
    assert result == original


def _isolated_pipeline(
    monkeypatch, original, candidate, *, heard=None, activity=None, refine_onsets=False
):
    """Isolate the final repair commit, after the local acoustic selector has chosen a pair."""
    heard = heard or [(word.text.casefold(), word.start, word.end) for word in candidate]
    timings = {i: (start, end) for i, (_, start, end) in enumerate(heard)}
    activity = _activity(*timings.values()) if activity is None else activity
    monkeypatch.setattr(speech, "read_mono", lambda *_: np.zeros(4 * 16000, np.float32))
    monkeypatch.setattr(
        speech, "_alignment_evidence", lambda *_: (_emissions(candidate), 0.02, heard)
    )
    monkeypatch.setattr(speech, "align_words", lambda *_: original)
    monkeypatch.setattr(speech, "align_guided", lambda *_, **__: original)
    monkeypatch.setattr(
        speech, "_alignment_windows", lambda *_: [ctc.Window(0, len(original), 0, 4)]
    )
    monkeypatch.setattr(speech, "contextual_guidance", lambda _w, windows, *_: (windows, timings))
    monkeypatch.setattr(speech, "singing_frames", lambda *_: activity)
    monkeypatch.setattr(speech, "voiced_frames", lambda *_: activity)
    monkeypatch.setattr(speech, "vocal_onsets", lambda *_: np.empty(0))
    monkeypatch.setattr(ctc, "voiced_frames", lambda *_: activity)
    monkeypatch.setattr(
        speech,
        "with_voice_onsets",
        ctc.with_voice_onsets if refine_onsets else lambda value, *_: value,
    )
    monkeypatch.setattr(speech, "with_sung_ends", lambda value, *_: value)
    monkeypatch.setattr(
        speech,
        "with_word_guidance",
        lambda value, *_, reviewed=frozenset(), **__: candidate if reviewed else value,
    )
    return speech.align(Path("synthetic.wav"), " ".join(w.text for w in original), "Russian")[
        "words"
    ]


def test_pipeline_preserves_the_neighbor_move_required_by_an_accepted_joint_repair(monkeypatch):
    original = [_word("дорога", 1, 1.1), _word("домой", 1.1, 2.5)]
    candidate = [_word("дорога", 1, 2, 0.99), _word("домой", 2, 2.5, 0.99)]
    result = _isolated_pipeline(monkeypatch, original, candidate)
    assert [(word["start"], word["end"]) for word in result] == [(1, 2), (2, 2.5)]


def test_acoustically_better_fast_word_is_kept_even_if_rate_warning_remains(monkeypatch):
    original = [_word("привет", 1, 1.08)]
    candidate = [_word("привет", 1, 1.12, 0.99)]
    result = _isolated_pipeline(monkeypatch, original, candidate)
    assert result[0]["end"] == 1.12


def test_local_onset_repair_does_not_recalibrate_distant_unchanged_words(monkeypatch):
    original = [
        _word("дом", 1.2, 1.5),
        _word("стоит", 1.7, 1.9),
        _word("тут", 2, 2.3),
        _word("далеко", 2.5, 2.8),
    ]
    candidate = [_word("дом", 1.05, 1.5, 0.99), *original[1:]]
    monkeypatch.setattr(speech, "rate_review_indices", lambda *_, **__: {0})
    result = _isolated_pipeline(
        monkeypatch, original, candidate, activity=_activity((1, 3)), refine_onsets=True
    )
    assert [word["start"] for word in result[1:]] == [1.5, 1.8, 2.3]


def test_unresolved_acoustic_review_is_exported_without_a_written_rate_warning(monkeypatch):
    original = [_word("дом", 1, 1.07)]
    result = _isolated_pipeline(monkeypatch, original, original, heard=[("дом", 1, 1.4)])
    assert "TimingReviewRequired" in result[0]["diagnostics"]
