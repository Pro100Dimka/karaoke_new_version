"""A separate guided window must preserve the preceding phonetic suffix."""

from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc


@pytest.mark.parametrize("text", [("дом", "там"), ("дім", "там")])
@pytest.mark.parametrize("next_start", [1.1, 1.22])
def test_guided_next_word_cannot_delete_supported_previous_letters(monkeypatch, text, next_start):
    previous = ctc.AlignedWord(text[0], 1.0, 1.3, (1.0, 1.06, 1.22), 0.9)
    following = ctc.AlignedWord(text[1], 1.36, 1.60, (1.36, 1.44, 1.52), 0.65)
    early = replace(following, start=next_start, letters=(next_start, 1.44, 1.52), score=0.92)
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda scores, step, words, window, **kw: [previous] if window.first == 0 else [early],
    )
    actual = ctc.align_guided(
        torch.zeros((200, 28)),
        0.02,
        list(text),
        [ctc.Window(0, 1, 0.8, 1.35, 1.0), ctc.Window(1, 2, 0.9, 1.8, 1.3)],
        {0: 1.0, 1: 1.3},
        np.ones(400, bool),
        [previous, following],
    )
    assert actual[0].end == previous.end
    assert actual[0].letters == previous.letters
    assert actual[1].start == following.start


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_ordered_reports_material_clip_that_zeroes_the_last_sounding_letter(text):
    previous = ctc.AlignedWord(text, 1.0, 1.3, (1.0, 1.06, 1.22), 0.9)
    following = ctc.AlignedWord("там", 1.22, 1.60, (1.22, 1.44, 1.52), 0.92)
    actual = ctc.ordered([previous, following])
    assert actual[0].end == previous.letters[-1]
    assert "BoundaryConflict" in actual[0].diagnostics
    assert ctc.ordered(actual) == actual


def test_silent_sign_on_the_cut_is_not_a_pronounced_anchor(monkeypatch):
    previous = ctc.AlignedWord("день", 1.0, 1.3, (1.0, 1.06, 1.2, 1.22), 0.9)
    following = ctc.AlignedWord("там", 1.36, 1.60, (1.36, 1.44, 1.52), 0.65)
    early = replace(following, start=1.22, letters=(1.22, 1.44, 1.52), score=0.92)
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda scores, step, words, window, **kw: [previous] if window.first == 0 else [early],
    )
    actual = ctc.align_guided(
        torch.zeros((200, 28)),
        0.02,
        ["день", "там"],
        [ctc.Window(0, 1, 0.8, 1.35, 1.0), ctc.Window(1, 2, 0.9, 1.8, 1.3)],
        {0: 1.0, 1: 1.3},
        np.ones(400, bool),
        [previous, following],
    )
    assert actual[1].start == early.start
    assert "BoundaryConflict" not in actual[0].diagnostics


@pytest.mark.parametrize("score", [0.0, 0.01, 0.05])
def test_weak_alignment_letters_do_not_veto_acoustic_candidate(monkeypatch, score):
    previous = ctc.AlignedWord("дім", 1.0, 1.3, (1.0, 1.1, 1.2), score)
    following = ctc.AlignedWord("там", 1.36, 1.60, (1.36, 1.44, 1.52), 0.65)
    early = replace(following, start=1.1, letters=(1.1, 1.44, 1.52), score=0.92)
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda scores, step, words, window, **kw: [previous] if window.first == 0 else [early],
    )
    actual = ctc.align_guided(
        torch.zeros((200, 28)),
        0.02,
        ["дім", "там"],
        [ctc.Window(0, 1, 0.8, 1.35, 1.0), ctc.Window(1, 2, 0.9, 1.8, 1.3)],
        {0: 1.0, 1: 1.3},
        np.ones(400, bool),
        [previous, following],
    )
    assert actual[1].start == early.start
    assert actual[0].end == early.start


def test_trailing_padding_without_lost_letter_anchor_does_not_veto_candidate(monkeypatch):
    previous = ctc.AlignedWord("дім", 1.0, 1.8, (1.0, 1.06, 1.22), 0.9)
    following = ctc.AlignedWord("там", 1.9, 2.1, (1.9, 1.98, 2.04), 0.65)
    early = replace(following, start=1.4, letters=(1.4, 1.98, 2.04), score=0.92)
    monkeypatch.setattr(
        ctc,
        "_align_window",
        lambda scores, step, words, window, **kw: [previous] if window.first == 0 else [early],
    )
    actual = ctc.align_guided(
        torch.zeros((200, 28)),
        0.02,
        ["дім", "там"],
        [ctc.Window(0, 1, 0.8, 1.9, 1.0), ctc.Window(1, 2, 1.2, 2.3, 1.4)],
        {0: 1.0, 1: 1.4},
        np.ones(400, bool),
        [previous, following],
    )
    assert actual[1].start == early.start
    assert actual[0].end == early.start
