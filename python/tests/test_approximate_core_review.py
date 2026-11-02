"""Regression from the frozen Kolyshnya local review; no model or label-time input.

This reduces competing intervals and scores observed on the cached recording;
the letter arrays are synthetic monotone inputs. The oracle is preservation of
acoustic evidence over zero-confidence ASR interpolation, not a hardcoded label.
"""

from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, word_guidance


_STEP = 0.02


def _word(text, start, end, score, letters=None):
    moments = (
        tuple(letters)
        if letters is not None
        else tuple(np.linspace(start, end, len(text), endpoint=False))
    )
    return ctc.AlignedWord(text, start, end, moments, score)


def _case():
    old = [
        _word("Холодний", 24.16, 25.56, 0),
        _word("завчасно", 25.5, 26.46, 0.789),
        _word("Це", 26.96, 28.62, 0),
        _word("досвід", 28.98, 30.28, 0.760),
    ]
    candidates = [
        _word("Холодний", 22.98, 24.48, 0.539),
        _word("завчасно", 25.5, 26.60, 0.789),
        _word("Це", 28.38, 28.58, 0.532),
        old[3],
    ]
    heard = {0: (24.16, 25.56), 1: (25.56, 26.96), 2: (26.96, 28.62), 3: (28.62, 30.28)}
    return old, candidates, heard, np.ones(4500, dtype=bool)


def test_active_asr_fallbacks_are_not_confirmed_anchors_for_joint_review():
    old, candidates, heard, activity = _case()
    # Both approximate cores overlap actual activity; inactivity alone cannot find this defect.
    assert not word_guidance._inactive_core(old[0], activity)
    assert not word_guidance._inactive_core(old[2], activity)

    assert word_guidance._supported_review(
        old, candidates, 0, frozenset({0, 1, 3}), heard, activity, _STEP
    )


def test_review_quality_counts_unaligned_zero_confidence_words():
    old, candidates, _, activity = _case()

    assert word_guidance._review_improves(old, candidates, [0, 1, 2], 0, {}, activity, _STEP)


@pytest.mark.parametrize("onsets", [(22.99, 25.4, 28.5), ()])
def test_approximate_entry_uses_bounded_existing_acoustic_context_once(monkeypatch, onsets):
    old, candidates, heard, activity = _case()
    scores = torch.zeros(2250, 28)
    calls = []

    def aligned(source, step, texts, window):
        assert source is scores and step == _STEP
        calls.append(window)
        available = candidates if window.start <= candidates[0].start else old
        return available[window.first : window.last]

    monkeypatch.setattr(ctc, "_align_window", aligned)
    result = word_guidance.with_word_guidance(
        old,
        scores,
        _STEP,
        [],
        heard,
        activity,
        0.6,
        onsets=onsets,
        reviewed=frozenset({0, 1, 3}),
    )

    assert result == (candidates if onsets else old)
    assert len(calls) == 1
    assert calls[0].end - calls[0].start <= 8 + 1e-9
    assert calls[0].last - calls[0].first <= 12
    assert result[3] == old[3]
    if onsets:
        assert calls[0].start < onsets[0] < old[0].start
        assert all(left.end <= right.start for left, right in zip(result, result[1:]))


@pytest.mark.parametrize("score", [0.02, 0.8])
def test_nonzero_acoustic_core_keeps_existing_asr_and_neighbor_guards(score):
    old, candidates, heard, activity = _case()
    old[2] = replace(old[2], score=score)

    assert not word_guidance._supported_review(
        old, candidates, 0, frozenset({0, 1, 3}), heard, activity, _STEP
    )


@pytest.mark.parametrize("kind", ["weak", "silent", "strong_neighbor_changed"])
def test_zero_confidence_exception_still_requires_active_strong_preserved_sequence(kind):
    old, candidates, _, activity = _case()
    if kind == "weak":
        candidates[0] = replace(candidates[0], score=0.01)
    elif kind == "silent":
        activity[2298:2448] = False
    else:
        candidates[3] = replace(candidates[3], end=30.0)

    assert not word_guidance._supported_review(
        old, candidates, 0, frozenset({0, 1, 2}), {}, activity, _STEP
    )


def test_approximate_context_does_not_revisit_previous_review_or_cross_outside_core(monkeypatch):
    old = [
        _word("раз", 1.0, 1.4, 0),
        _word("два", 1.5, 2.0, 0.8),
        _word("три", 4.5, 4.9, 0),
        _word("чотири", 5.0, 5.5, 0.8),
    ]
    calls = []

    def aligned(_scores, _step, _texts, window):
        calls.append(window)
        return old[window.first : window.last]

    monkeypatch.setattr(ctc, "_align_window", aligned)
    result = word_guidance.with_word_guidance(
        old,
        torch.zeros(400, 28),
        _STEP,
        [],
        {},
        np.ones(800, dtype=bool),
        0.6,
        reviewed=frozenset({0, 3}),
        onsets=(0.3, 2.2, 3.0),
    )

    assert result == old
    assert len(calls) == 2
    assert calls[0].end <= calls[1].start
    assert calls[1].start >= old[1].end
    assert all(window.end - window.start <= 8 + 1e-9 for window in calls)
