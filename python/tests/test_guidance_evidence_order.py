import numpy as np
import pytest
import torch

from backend.ai_worker import ctc, word_guidance
from backend.ai_worker.guidance_neighbors import _phrase_timings


def _apply(options, heard, scores, monkeypatch, local=None):
    original = [choices[0] for choices in options]
    pass_ = word_guidance._GuidancePass(
        original, scores, 0.02, heard, np.ones(600, bool), 0.6, (), (), frozenset()
    )
    observed = {}

    def add(_self, target, _first, _window, _phrase, timings):
        observed.update(timings)
        for choices, alternatives in zip(target, options, strict=True):
            choices.extend(alternatives[1:])

    monkeypatch.setattr(word_guidance._GuidancePass, "_phrase", lambda *_: (None, local or {}))
    monkeypatch.setattr(word_guidance._GuidancePass, "_add_alternatives", add)
    result = list(original)
    pass_.apply(result, ctc.Window(0, len(original), 0.0, 6.0))
    return result, observed


def test_partial_phrase_cannot_move_known_words_behind_the_previous_retained_word(monkeypatch):
    known = {0: (4.0, 4.5), 1: (4.5, 5.0), 2: (5.0, 5.5)}
    options = [
        [ctc.AlignedWord(text, start, end, (start,), 0.2)]
        for text, (start, end) in zip(("one", "two", "three"), known.values(), strict=True)
    ]
    local = {1: (2.0, 2.5), 2: (2.5, 3.0)}

    _, observed = _apply(options, known, torch.zeros(300, 28), monkeypatch, local)

    assert observed == known


def test_a_complete_earlier_phrase_correction_remains_available():
    known = {0: (4.0, 4.5), 1: (4.5, 5.0), 2: (5.0, 5.5)}
    local = {0: (1.0, 1.5), 1: (1.5, 2.0), 2: (2.0, 2.5)}

    assert _phrase_timings(known, local) == local


def _suffix_case(text="ab", strength=0.001):
    before = ctc.AlignedWord(text, 1.0, 3.0, (1.0, 2.8), 0.4)
    late = ctc.AlignedWord("cd", 3.1, 3.5, (3.1, 3.3), 0.01)
    candidate = ctc.AlignedWord("cd", 1.8, 2.4, (1.8, 2.2), 0.1)
    scores = torch.full((300, 28), np.log(0.001))
    tokens = ctc._character_tokens(text)
    scores[50, tokens[0][0]] = np.log(0.8)
    scores[140, tokens[-1][0]] = np.log(strength)
    return [[before], [late, candidate]], {0: (1.0, 1.6), 1: (1.8, 2.4)}, scores


def test_a_strong_word_average_cannot_protect_its_unsupported_clipped_letter(monkeypatch):
    options, heard, scores = _suffix_case()

    result, _ = _apply(options, heard, scores, monkeypatch)

    assert result[1] == options[1][1]
    assert "BoundaryConflict" in ctc.ordered(result)[0].diagnostics


@pytest.mark.parametrize("text,strength", [("ab", 0.2), ("ах", 0.001), ("17", 0.001)])
def test_supported_or_multiphoneme_letters_keep_their_existing_protection(
    text, strength, monkeypatch
):
    options, heard, scores = _suffix_case(text, strength)

    result, _ = _apply(options, heard, scores, monkeypatch)

    assert result[0] == options[0][0]
    assert result[1] == options[1][0]


def test_a_phoneme_supported_after_its_first_frame_remains_protected(monkeypatch):
    options, heard, scores = _suffix_case()
    token = ctc._character_tokens(options[0][0].text)[-1][0]
    scores[141, token] = np.log(0.2)

    result, _ = _apply(options, heard, scores, monkeypatch)

    assert result[1] == options[1][0]


def test_selection_without_emissions_keeps_its_previous_anchor_protection():
    options, _, _ = _suffix_case()

    assert not word_guidance._compatible(
        options[0][0], options[1][1], options[0][0], np.ones(600, bool)
    )
