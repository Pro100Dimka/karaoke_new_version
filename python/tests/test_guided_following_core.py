from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
import torch

from backend.ai_worker import ctc


def _scenario(
    monkeypatch,
    *,
    evidence="strong",
    anchored_next=True,
    anchored_tail=False,
    next_score=0.9,
    reference_score=0.001,
    next_start=2.0,
    next_text="tone",
    reference_blocked=False,
    overlap=True,
):
    reference = ctc.AlignedWord(
        "so", next_start - 0.04, next_start, (next_start - 0.04, next_start - 0.02), reference_score
    )
    following = ctc.AlignedWord(
        next_text,
        next_start,
        next_start + 0.06 * len(next_text),
        tuple(next_start + 0.06 * i for i in range(len(next_text))),
        next_score,
    )
    borrowed = ctc.AlignedWord("so", 2.0, 2.1, (2.0, 2.06), 0.45)
    if not overlap:
        borrowed = replace(borrowed, start=1.88, end=2.0, letters=(1.88, 1.94))
    damaged = replace(
        following,
        start=2.12,
        end=2.24,
        letters=tuple(np.linspace(2.12, 2.22, len(next_text))),
        score=0.001,
    )
    whole = [reference, following]
    windows = [ctc.Window(0, 1, 1.8, 2.2), ctc.Window(1, 2, 1.9, 2.5)]
    if reference_blocked:
        previous = ctc.AlignedWord("lead", 1.2, 1.9, (1.2, 1.4, 1.6, 1.8), 0.4)
        whole.insert(0, previous)
        windows = [
            ctc.Window(0, 1, 1.0, 2.0),
            ctc.Window(1, 2, 1.8, 2.2),
            ctc.Window(2, 3, 1.9, 2.5),
        ]
    tail, after = len(whole) - 2, len(whole) - 1
    heard = {after: 2.02}
    anchors = {after: 2.02} if anchored_next else {}
    if anchored_tail:
        heard[tail] = anchors[tail] = 1.96

    scores = torch.full((200, 28), -12.0)
    scores[:, 0] = 0
    for index, tokens in enumerate(ctc._character_tokens(next_text)):
        frame = round(following.letters[index] / 0.02)
        for token in tokens:
            for offset in range(3):
                moment = (frame + offset) * 0.02
                supported = evidence == "strong" or moment >= 2.1
                supported |= evidence == "inside_span" and index == 0 and offset == 2
                if supported:
                    scores[frame + offset, 0] = -12
                    scores[frame + offset, token] = 0

    def crop(_scores, _step, chunk, window, **_options):
        if chunk == ["lead"]:
            return [replace(whole[0], end=2.0, letters=(1.2, 1.4, 1.6, 1.98), score=0.9)]
        if chunk == ["so"]:
            return [borrowed]
        return [damaged if window.start >= borrowed.end else following]

    monkeypatch.setattr(ctc, "_align_window", crop)
    result = ctc.align_guided(
        scores.log_softmax(-1),
        0.02,
        [word.text for word in whole],
        windows,
        heard,
        np.ones(400, dtype=bool),
        whole,
        anchors=anchors,
    )
    return result[tail:], reference, following, borrowed


@pytest.mark.parametrize("evidence", ["strong", "inside_span"])
def test_an_unheard_guided_tail_cannot_take_the_next_recognized_core(monkeypatch, evidence):
    result, reference, following, _ = _scenario(monkeypatch, evidence=evidence)

    assert result == ctc.ordered([reference, following])
    assert result[0].score < 0.05, "The unconfirmed word must remain visibly weak"
    assert result[1].score == following.score


@pytest.mark.parametrize(
    "options",
    [
        {"anchored_next": False},
        {"next_start": 1.0},
        {"next_score": 0.01},
        {"anchored_tail": True},
        {"evidence": "unsupported_prefix"},
        {"reference_blocked": True},
        {"reference_score": 0.3},
        {"overlap": False},
    ],
    ids=[
        "interpolated_position_is_not_an_anchor",
        "earlier_repeat_is_not_the_current_core",
        "weak_next_core",
        "independently_heard_tail",
        "only_later_phonemes_are_supported",
        "reference_already_rejected_by_previous_word",
        "supported_reference_tail",
        "touching_boundaries_do_not_overlap",
    ],
)
def test_ambiguous_or_nonconflicting_guidance_keeps_the_existing_choice(monkeypatch, options):
    result, _, _, borrowed = _scenario(monkeypatch, **options)

    assert result[0].score == borrowed.score
    assert result[0].start == borrowed.start


@pytest.mark.parametrize("text", ["12", "жук"])
def test_numbers_and_multitoken_letters_keep_the_existing_choice(monkeypatch, text):
    result, _, _, borrowed = _scenario(monkeypatch, next_text=text)

    assert result[0].score == borrowed.score
