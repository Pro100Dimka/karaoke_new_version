from __future__ import annotations

import numpy as np
import pytest
import torch
from torchaudio.pipelines import MMS_FA

from backend.ai_worker import ctc
from backend.ai_worker.word_guidance import with_word_guidance


def _emissions(*words):
    size = len(MMS_FA.get_dict(star=None))
    probabilities = torch.full((150, size), 0.01 / (size - 1))
    probabilities[:, 0] = 0.99
    for text, frames, strengths in words:
        tokens = [token for character in ctc._character_tokens(text) for token in character]
        for token, frame, strength in zip(tokens, frames, strengths, strict=True):
            probabilities[frame] = (1 - strength) / (size - 1)
            probabilities[frame, token] = strength
    return probabilities.log()


@pytest.mark.parametrize("texts", [("дом", "мир"), ("дім", "мій"), ("hum", "man")])
def test_word_guidance_cannot_reuse_the_previous_supported_consonant(texts):
    # Independent word crops can consume the same token twice. The whole phrase
    # has distinct final/initial consonants at 1.60 and 2.00 s; coarse recognition
    # starts the second word early enough for its crop to see the stronger first.
    scores = _emissions(
        (texts[0], (50, 60, 80), (0.95, 0.95, 0.95)),
        (texts[1], (100, 110, 120), (0.8, 0.95, 0.95)),
    )
    whole = ctc.align_words(scores, 0.02, texts)
    assert whole[0].letters[-1] == 1.6
    assert whole[1].start == 2.0

    guided = with_word_guidance(
        whole,
        scores,
        0.02,
        [ctc.Window(0, 2, 0, 3)],
        {0: (1.0, 1.5), 1: (1.5, 2.5)},
        np.ones(300, bool),
        0.6,
    )

    assert ctc.ordered(guided) == whole


def test_guidance_recovers_a_word_without_borrowing_its_supported_neighbors_consonant():
    scores = _emissions(("am", (50, 70), (0.95, 0.2)), ("me", (90, 100), (0.95, 0.95)))
    # CTC's blank still dominates the quiet first consonant; the later word's
    # stronger consonant must not displace it merely because the crop includes it.
    scores[70] = np.log(0.05 / (scores.shape[1] - 2))
    scores[70, 0] = np.log(0.75)
    scores[70, ctc._character_tokens("am")[-1][0]] = np.log(0.2)
    wrong = ctc.AlignedWord("am", 0.2, 0.5, (0.2, 0.4), 0.001)
    following = ctc.AlignedWord("me", 1.8, 2.02, (1.8, 2.0), 0.95)

    guided = with_word_guidance(
        [wrong, following],
        scores,
        0.02,
        [ctc.Window(0, 2, 0, 3)],
        {0: (0.8, 1.5), 1: (1.8, 2.02)},
        np.ones(300, bool),
        0.6,
    )

    assert (guided[0].start, guided[0].end) == pytest.approx((1.0, 1.42))
    assert guided[0].letters == pytest.approx((1.0, 1.4))
    assert guided[0].score > 0
    assert guided[1] == following
