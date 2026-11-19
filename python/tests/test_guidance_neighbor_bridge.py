from dataclasses import replace

import numpy as np
import torch

from backend.ai_worker import ctc, word_guidance
from backend.ai_worker.guidance_neighbors import _bridge_candidates


def _case():
    before = ctc.AlignedWord("ab", 1.0, 1.6, (1.0, 1.5), 0.9)
    misplaced = ctc.AlignedWord("ce", 3.0, 3.04, (3.0, 3.02), 0.002)
    overlapping = ctc.AlignedWord("ce", 1.5, 1.56, (1.5, 1.54), 0.01)
    late = ctc.AlignedWord("day", 3.1, 3.3, (3.1, 3.2, 3.28), 0.003)
    supported = ctc.AlignedWord("day", 1.8, 2.4, (1.8, 2.0, 2.3), 0.8)
    options = [[before], [misplaced, overlapping], [late, supported]]
    heard = {0: (1.0, 1.6), 1: (1.5, 1.75), 2: (1.8, 2.4)}
    probabilities = torch.full((200, 28), 0.001 / 27)
    probabilities[:, 0] = 0.999
    for word, frames in ((before, (50, 75)), (supported, (90, 100, 115))):
        tokens = [token for part in ctc._character_tokens(word.text) for token in part]
        for token, frame in zip(tokens, frames, strict=True):
            probabilities[frame] = (1 - word.score) / 27
            probabilities[frame, token] = word.score
    tokens = [token for part in ctc._character_tokens("ce") for token in part]
    for token, frame in zip(tokens, (82, 86), strict=True):
        probabilities[frame] = 0.01 / 27
        probabilities[frame, 0] = 0.98
        probabilities[frame, token] = 0.01
    return options, heard, probabilities.log(), np.ones(400, bool)


def _guide(options, heard, scores, voiced, monkeypatch):
    original = [choices[0] for choices in options]
    pass_ = word_guidance._GuidancePass(
        original, scores, 0.02, heard, voiced, 0.6, (), (), frozenset()
    )

    def add(_self, target, *_args):
        for choices, alternatives in zip(target, options, strict=True):
            choices.extend(alternatives[1:])

    monkeypatch.setattr(word_guidance._GuidancePass, "_phrase", lambda *_: (None, {}))
    monkeypatch.setattr(word_guidance._GuidancePass, "_add_alternatives", add)
    result = list(original)
    pass_.apply(result, ctc.Window(0, 3, 0.0, 4.0))
    return result


def test_a_weak_middle_word_cannot_displace_either_supported_neighbour(monkeypatch):
    options, heard, scores, voiced = _case()

    result = _guide(options, heard, scores, voiced, monkeypatch)

    assert result[0] == options[0][0]
    assert result[2] == options[2][1]
    assert result[0].end <= result[1].start < result[1].end <= result[2].start
    assert 0 < result[1].score <= ctc._PREFERENCE
    assert "TimingReviewRequired" in result[1].diagnostics
    ordered = ctc.ordered(result)
    assert ordered[0] == result[0]
    assert ordered[2] == result[2]
    assert ordered[1].letters == result[1].letters
    assert ordered[1].diagnostics == result[1].diagnostics


def test_a_bridge_cannot_collapse_a_previously_uncrammed_word():
    options, _, scores, voiced = _case()
    options[1][0] = replace(options[1][0], end=3.2)
    options[2][1] = replace(options[2][1], start=1.62, letters=(1.62, 2.0, 2.3))

    assert _bridge_candidates(options, scores, 0.02, voiced) == []


def test_a_bridge_requires_two_supported_neighbours():
    options, _, scores, voiced = _case()
    options[2] = [replace(word, score=0.01) for word in options[2]]

    assert _bridge_candidates(options, scores, 0.02, voiced) == []


def test_a_bridge_does_not_add_a_weak_replacement_for_a_supported_middle_word():
    options, _, scores, voiced = _case()
    options[1].append(replace(options[1][1], score=0.2))

    assert _bridge_candidates(options, scores, 0.02, voiced) == []


def test_a_failed_bridge_alignment_does_not_invent_a_proportional_word(monkeypatch):
    options, _, scores, voiced = _case()
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda _scores, _step, words, window: ctc._evenly(words, window.start, window.end),
    )

    assert _bridge_candidates(options, scores, 0.02, voiced) == []
