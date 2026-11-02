"""Frozen Pivovarov selection regression; no model calls or asserted true onset.

The concrete CTC cores were recorded before this proposed fix. Their competing
onsets remain uncertain; only the loss of their shared suffix to interpolation
is established here.
"""

from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, word_guidance
from backend.ai_worker.recognition import alignment_payload


@pytest.fixture
def competing_cores():
    original = ctc.AlignedWord(
        "Хвилями,",
        0.14,
        1.42,
        (0.14, 0.72, 0.82, 1.06, 1.08, 1.30, 1.40, 1.42),
        0.4910756893869903,
    )
    phonetic = replace(
        original, start=0.60, letters=(0.60, *original.letters[1:]), score=0.501649550252801
    )
    following = ctc.AlignedWord(
        "хвилями,",
        1.66,
        2.48,
        (1.66, 1.76, 1.84, 2.10, 2.12, 2.34, 2.46, 2.48),
        0.4681893009573186,
    )
    scores = torch.full((160, 28), -10.0)
    token = ctc._character_tokens(original.text)[0][0]
    scores[7, token] = np.log(0.0265)
    return original, phonetic, following, scores, np.ones(320, dtype=bool)


def choose(competing_cores, monkeypatch, aligned):
    original, _, following, scores, activity = competing_cores
    monkeypatch.setattr(ctc, "_align_window", lambda *_args, **_kwargs: [aligned])
    candidates = word_guidance._candidates(
        original,
        scores,
        0.02,
        ctc.Window(0, 2, 0.0, 3.0),
        (0.56, 1.32),
        activity,
        0.6,
    )
    selected = word_guidance._select_sequence(
        [original, following],
        [[original, *candidates], [following]],
        {0: (0.56, 1.32)},
        0,
        activity,
    )
    return candidates, selected


def test_coarse_asr_end_cannot_replace_an_admissible_acoustic_suffix_with_even_spacing(
    competing_cores,
    monkeypatch,
):
    original, phonetic, following, _, _ = competing_cores

    _, selected = choose(competing_cores, monkeypatch, phonetic)

    assert selected[0].score > 0
    assert selected[0].letters[1:] == original.letters[1:] == phonetic.letters[1:]
    assert selected[1] == following


def test_failed_ctc_retains_an_explicit_zero_confidence_fallback(competing_cores, monkeypatch):
    original = competing_cores[0]
    approximate = ctc._evenly([original.text], 0.56, 1.32)[0]

    candidates, selected = choose(competing_cores, monkeypatch, approximate)

    assert candidates
    assert selected[0].score == 0
    assert "ApproximateAlignment" in alignment_payload(selected, {})["words"][0]["diagnostics"]


def test_a_rejected_ctc_alternative_does_not_remove_the_only_usable_fallback(
    competing_cores, monkeypatch
):
    original, phonetic, _, _, _ = competing_cores
    # A search can put the word near the next occurrence. The existing entry
    # guard rejects this positive-score candidate before sequence selection.
    outside = replace(
        phonetic,
        start=1.70,
        end=1.90,
        letters=(1.70, 1.72, 1.76, 1.78, 1.80, 1.84, 1.88, 1.90),
    )

    candidates, selected = choose(competing_cores, monkeypatch, outside)

    assert candidates
    assert all(word.score == 0 for word in candidates)
    assert selected[0].score == 0
