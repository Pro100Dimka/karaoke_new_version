from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc_singing, ctc, recognition, speech, word_guidance


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


@pytest.mark.parametrize("text", ["в", "у", "й"])
def test_short_unsupported_ctc_word_is_reviewed_without_an_asr_match(text):
    # A real GTSinger entry produced one CTC frame at probability 1.86e-6;
    # independent recognition omitted it, so neither written-rate nor ASR checks saw it.
    word = ctc.AlignedWord(text, 0, 0.02, (0,), 1.86e-6)

    assert recognition.rate_review_indices([word], text) == {0}
    assert recognition.rate_review_indices([_word(text, 0, 0.02, 0.9)], text) == set()


@pytest.mark.parametrize("text", ["в", "у", "й"])
def test_independent_agreement_preserves_a_weak_but_genuinely_fast_word(text):
    word = _word(text, 1, 1.03, 0.03)

    assert (
        recognition.rate_review_indices(
            [word], text, heard={0: (1, 1.03)}, activity=_activity((1, 1.03))
        )
        == set()
    )
    # A proportional fallback has no acoustic support, even if its endpoints coincide.
    assert recognition.rate_review_indices(
        [_word(text, 1, 1.03, 0)], text, heard={0: (1, 1.03)}
    ) == {0}


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


@pytest.mark.parametrize("texts", [("дом", "там"), ("дім", "там")])
def test_normalized_shortening_reaches_joint_review_without_independent_asr(texts):
    actual = [
        ctc.AlignedWord(texts[0], 1, 1.3, (1, 1.04, 1.28), 0.99),
        ctc.AlignedWord(texts[1], 1.3, 1.6, (1.3, 1.38, 1.58), 0.99),
    ]
    original = [_word(texts[0], 1, 1.3), _word(texts[1], 1.1, 1.6)]
    normalized = ctc.ordered(original)
    activity = _activity((1, 1.6))
    reviewed = recognition.rate_review_indices(normalized, " ".join(texts), activity=activity)

    result = word_guidance.with_word_guidance(
        normalized,
        _emissions(actual),
        0.02,
        [ctc.Window(0, 2, 0.5, 2)],
        {},
        activity,
        0.6,
        reviewed=frozenset(reviewed),
    )

    assert [(word.start, word.end) for word in ctc.ordered(result)] == [
        (1, 1.3),
        (1.3, 1.6),
    ]
    assert result[0].letters == actual[0].letters


def test_normalization_records_small_clipping_without_rechecking_ordinary_onset_lag():
    words = [
        ctc.AlignedWord("дома", 1, 1.7, (1, 1.1, 1.4, 1.5), 0.9),
        _word("мы", 1.6, 2),
    ]
    normalized = ctc.ordered(words)

    assert "BoundaryClipped" in normalized[0].diagnostics
    assert recognition.rate_review_indices(normalized, "дома мы") == set()
    assert ctc.ordered(normalized) == normalized


def test_ordering_reserves_a_positive_duration_on_the_serialized_millisecond_grid():
    words = [
        ctc.AlignedWord("а", 1.0015, 1.0016, (1.0015,)),
        ctc.AlignedWord("і", 1.0024, 1.0025, (1.0024,)),
    ]

    result = ctc.ordered(words)

    assert all(word.start < word.end for word in result)
    assert result[0].end <= result[1].start
    assert all(word.start <= word.letters[0] <= word.end for word in result)
    assert ctc.ordered(result) == result


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
    monkeypatch.setattr(ctc_singing, "voiced_frames", lambda *_: activity)
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


def test_unchanged_local_review_keeps_timings_without_repeating_audio_postprocessing(monkeypatch):
    from unittest.mock import patch

    align = speech.align

    def measured_align(*args, **kwargs):
        with (
            patch.object(speech, "with_voice_onsets", wraps=speech.with_voice_onsets) as onsets,
            patch.object(speech, "with_sung_ends", wraps=speech.with_sung_ends) as ends,
        ):
            result = align(*args, **kwargs)
            assert onsets.call_count == ends.call_count == 1
            return result

    monkeypatch.setattr(speech, "align", measured_align)
    original = [_word("дом", 1, 1.07)]
    result = _isolated_pipeline(monkeypatch, original, original, heard=[("дом", 1, 1.4)])
    assert (result[0]["start"], result[0]["end"]) == (1, 1.07)
    assert "TimingReviewRequired" in result[0]["diagnostics"]


def test_accepted_local_repair_reuses_unchanged_audio_features(monkeypatch):
    from contextlib import ExitStack
    from unittest.mock import patch

    align = speech.align
    calls = {"voiced_frames": 0, "harmonic_evidence": 0}

    def measured_align(*args, **kwargs):
        with ExitStack() as patches:
            for name in calls:
                compute = getattr(ctc_singing, name)

                def measured(*args, _name=name, _compute=compute):
                    calls[_name] += 1
                    return _compute(*args)

                for module in (ctc_singing, speech):
                    if hasattr(module, name):
                        patches.enter_context(patch.object(module, name, measured))
            for name in ("with_voice_onsets", "with_sung_ends"):
                patches.enter_context(patch.object(speech, name, getattr(ctc, name)))
            result = align(*args, **kwargs, instrumental=Path("backing.wav"))
        assert calls == {"voiced_frames": 1, "harmonic_evidence": 1}
        return result

    monkeypatch.setattr(speech, "align", measured_align)
    original = [_word("дорога", 1, 1.1), _word("домой", 1.1, 2.5)]
    candidate = [_word("дорога", 1, 2, 0.99), _word("домой", 2, 2.5, 0.99)]
    result = _isolated_pipeline(monkeypatch, original, candidate)
    assert [(word["start"], word["end"]) for word in result] == [(1, 2), (2, 2.5)]
