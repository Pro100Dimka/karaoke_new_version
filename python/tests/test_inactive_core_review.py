"""A disputed whole core can be misplaced even when its local context is correct."""

from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, word_guidance


_STEP = 0.02


def _word(text, start, end, score):
    letters = tuple(np.linspace(start, end - _STEP, len(text)))
    return ctc.AlignedWord(text, start, end, letters, score)


def _case(text="смотрят"):
    old = [
        _word("там", 0.5, 0.9, 0.8),
        _word(text, 1.2, 1.6, 0.02),
        _word("вдаль", 3.4, 3.8, 0.8),
    ]
    candidate = _word(text, 2.4, 3.0, 0.8)
    activity = np.zeros(500, dtype=bool)
    for word in (old[0], candidate, old[2]):
        activity[round(word.start * 100) : round(word.end * 100)] = True
    scores = torch.full((250, 28), np.log(1e-6))
    scores[:, 0] = np.log(0.99)
    for word in (*old, candidate):
        for at, tokens in zip(word.letters, ctc._character_tokens(word.text), strict=True):
            for offset, token in enumerate(tokens):
                scores[round(at / _STEP) + offset, token] = np.log(word.score)
    return old, candidate, scores, activity


def _guide(monkeypatch, old, candidate, scores, activity, *, onsets=(2.4,)):
    """The full context repeats a false path; the actual onset yields a strong path."""
    calls = []

    def align_window(emission, step, texts, window):
        assert emission is scores and step == _STEP
        calls.append(window)
        replacements = {word.text: word for word in old}
        if candidate.start - _STEP <= window.start <= candidate.start + _STEP:
            replacements[candidate.text] = candidate
        return [replacements[text] for text in texts]

    monkeypatch.setattr(ctc, "_align_window", align_window)
    result = word_guidance.with_word_guidance(
        old,
        scores,
        _STEP,
        [],
        {1: (1.0, 3.1)},  # Coarse independent phrase support, not an acoustic onset.
        activity,
        0.6,
        onsets=onsets,
        reviewed=frozenset({1}),
    )
    return result, calls


@pytest.mark.parametrize("text", ["смотрят", "дивляться"])
def test_inactive_later_core_uses_existing_onset_without_retiming_context(text, monkeypatch):
    old, candidate, scores, activity = _case(text)

    result, calls = _guide(monkeypatch, old, candidate, scores, activity)

    assert (result[1].start, result[1].end, result[1].letters) == (
        candidate.start,
        candidate.end,
        candidate.letters,
    )
    assert result[0] == old[0] and result[2] == old[2]
    assert result[0].end <= result[1].start < result[1].end <= result[2].start
    assert len(calls) <= 2  # One unchanged context and one supported local alternative.
    assert all(window.end - window.start <= 8 for window in calls)
    assert all(window.last - window.first <= 3 for window in calls)


@pytest.mark.parametrize("kind", ["strong_core", "active_nasal", "fast_word", "no_onset"])
def test_local_alternative_does_not_discard_supported_or_unrecoverable_core(kind, monkeypatch):
    old, candidate, scores, activity = _case("мир" if kind == "active_nasal" else "дом")
    onsets = (2.4,)
    if kind == "strong_core":
        old[1] = replace(old[1], score=0.8)
    elif kind == "active_nasal":
        old[1] = replace(old[1], letters=(1.2, 1.54, 1.58))
        activity[120:160] = True
    elif kind == "fast_word":
        old[1] = _word("дом", 1.2, 1.26, 0.02)
        activity[120:126] = True
    else:
        onsets = ()

    result, calls = _guide(monkeypatch, old, candidate, scores, activity, onsets=onsets)

    assert result == old
    assert len(calls) == 1


def test_coarse_asr_start_does_not_veto_strong_active_replacement_of_inactive_core():
    old, candidate, _, activity = _case()

    assert word_guidance._supported_review(
        old,
        [old[0], candidate, old[2]],
        0,
        frozenset({1}),
        {1: (1.0, 3.1)},
        activity,
        _STEP,
    )


@pytest.mark.parametrize("invalid_context", [False, True])
def test_rejected_stronger_onset_cannot_hide_an_acceptable_local_candidate(
    monkeypatch, invalid_context
):
    old, candidate, scores, activity = _case()
    outside = _word(candidate.text, 3.1, 3.3, 0.9)
    activity[310:330] = True
    token = ctc._character_tokens(candidate.text)[0][0]
    scores[155, token] = np.log(outside.score)
    calls = []

    def align_window(emission, step, texts, window):
        calls.append(window)
        if len(texts) > 1:
            return [old[0], outside, old[2]] if invalid_context else old
        return [candidate if abs(window.start - candidate.start) < step else outside]

    monkeypatch.setattr(ctc, "_align_window", align_window)
    result = word_guidance.with_word_guidance(
        old,
        scores,
        _STEP,
        [],
        {1: (1.0, 3.1)},
        activity,
        0.6,
        onsets=(2.4, 3.1),
        reviewed=frozenset({1}),
    )

    assert result[1].start == candidate.start
    assert result[1].end == candidate.end
    assert result[0] == old[0] and result[2] == old[2]
    assert len(calls) == 3


@pytest.mark.parametrize(
    "kind", ["strong_old", "active_old", "inactive_candidate", "weak_candidate", "outside_asr"]
)
def test_coarse_asr_exception_requires_both_missing_old_activity_and_supported_candidate(kind):
    old, candidate, _, activity = _case()
    heard = {1: (1.0, 3.1)}
    if kind == "strong_old":
        old[1] = replace(old[1], score=0.7)
    elif kind == "active_old":
        activity[120:160] = True
    elif kind == "inactive_candidate":
        activity[240:300] = False
    elif kind == "weak_candidate":
        candidate = replace(candidate, score=0.03)
    else:
        heard = {1: (1.0, 2.3)}

    assert not word_guidance._supported_review(
        old,
        [old[0], candidate, old[2]],
        0,
        frozenset({1}),
        heard,
        activity,
        _STEP,
    )
