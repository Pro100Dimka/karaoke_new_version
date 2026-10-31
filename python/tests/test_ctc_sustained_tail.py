from __future__ import annotations

import pytest
import numpy as np
import torch
from torchaudio.pipelines import MMS_FA

from backend.ai_worker.ctc import (
    _character_tokens,
    _transcript_path,
    align_words,
    with_sung_ends,
    with_sung_letters,
)


def _probabilities(
    text: str, frames: tuple[int, ...], blank: float = 0.8
) -> tuple[torch.Tensor, list[int]]:
    tokens = [token for character in _character_tokens(text) for token in character]
    size = len(MMS_FA.get_dict(star=None))
    probabilities = torch.full((85, size), (1 - blank) / (size - 1))
    probabilities[:, 0] = blank
    for frame, token in zip(frames, tokens, strict=True):
        probabilities[frame] = 0.05 / (size - 1)
        probabilities[frame, token] = 0.95
    return probabilities, tokens


def _weak_early_consonant(probabilities: torch.Tensor, token: int, frame: int = 14) -> None:
    probabilities[frame] = 0.05 / (probabilities.shape[-1] - 2)
    probabilities[frame, 0] = 0.75
    probabilities[frame, token] = 0.2


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_unmatched_tail_cannot_reward_a_weak_early_consonant_over_the_held_word(text: str) -> None:
    # CTC is mostly blank through the hold. The final consonant has a weak false
    # spike at .28 s and a strong measured onset at 1.20 s. A zero-cost wildcard
    # incorrectly saves all intervening blank costs by ending the word at .30 s.
    probabilities, tokens = _probabilities(text, (10, 12, 60))
    _weak_early_consonant(probabilities, tokens[-1])

    word = align_words(probabilities.log(), 0.02, [text], bounded_end=True)[0]

    assert (word.start, word.end) == pytest.approx((0.2, 1.22))
    assert word.letters == pytest.approx((0.2, 0.24, 1.2))
    assert word.score == pytest.approx(0.95)


def test_unmatched_tail_preserves_per_frame_ctc_score_normalization() -> None:
    probabilities, tokens = _probabilities("дом", (10, 12, 60), blank=0.99)
    _weak_early_consonant(probabilities, tokens[-1])
    scores = probabilities.log()

    # Every alignment path traverses every frame. An offset shared by every
    # label in that frame must not change where words or letters are placed.
    assert torch.equal(
        _transcript_path(scores, tokens, bounded_end=True),
        _transcript_path(scores - 0.2, tokens, bounded_end=True),
    )


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_supported_fast_phonemes_are_not_stretched_by_unmatched_tail(text: str) -> None:
    probabilities, _ = _probabilities(text, (10, 11, 12))

    word = align_words(probabilities.log(), 0.01, [text])[0]

    assert (word.start, word.end) == pytest.approx((0.1, 0.13))
    assert word.letters == pytest.approx((0.1, 0.11, 0.12))


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_bounded_fast_word_can_use_the_final_frame_without_an_unmatched_tail(text: str) -> None:
    probabilities, _ = _probabilities(text, (10, 11, 12))

    word = align_words(probabilities[10:13].log(), 0.01, [text], 0.1, bounded_end=True)[0]

    assert (word.start, word.end) == pytest.approx((0.1, 0.13))
    assert word.letters == pytest.approx((0.1, 0.11, 0.12))


def test_supported_final_consonant_is_not_replaced_by_a_stronger_later_echo() -> None:
    probabilities, tokens = _probabilities("дом", (10, 12, 14))
    probabilities[60] = 0.01 / (probabilities.shape[-1] - 1)
    probabilities[60, tokens[-1]] = 0.99

    word = align_words(probabilities.log(), 0.02, ["дом"])[0]

    assert (word.start, word.end) == pytest.approx((0.2, 0.3))
    assert word.letters == pytest.approx((0.2, 0.24, 0.28))


@pytest.mark.parametrize("text", ["дом", "дім"])
def test_sung_interval_rechecks_last_consonant_without_moving_word_or_prefix(text: str) -> None:
    probabilities, tokens = _probabilities(text, (10, 12, 60))
    _weak_early_consonant(probabilities, tokens[-1])
    scores = probabilities.log()
    raw = align_words(scores, 0.02, [text])
    assert raw[0].end == 0.3  # The unconstrained outro-safe path still needs independent evidence.
    activity = np.zeros(170, bool)
    activity[20:122] = True
    times = np.arange(27200) / 16000
    samples = (0.2 * np.sin(2 * np.pi * 220 * times) * ((times >= 0.2) & (times < 1.22))).astype(
        np.float32
    )
    timed = with_sung_ends(raw, samples, voiced=activity)
    assert timed[0].letters[-1] == 0.28

    fixed = with_sung_letters(timed, scores, 0.02, activity, {0: (0.2, 1.22)})

    assert (fixed[0].start, fixed[0].end) == (timed[0].start, timed[0].end)
    assert fixed[0].letters[:2] == timed[0].letters[:2]
    assert fixed[0].letters[-1] == 1.2
    assert "SungConsonantRetimed" in fixed[0].diagnostics


@pytest.mark.parametrize(
    "evidence", ["no-independent-end", "pause-before-echo", "reliable-consonant"]
)
def test_ambiguous_sung_tail_cannot_replace_reliable_letters(evidence: str) -> None:
    from dataclasses import replace

    probabilities, tokens = _probabilities("дом", (10, 12, 60))
    _weak_early_consonant(probabilities, tokens[-1])
    scores = probabilities.log()
    raw = align_words(scores, 0.02, ["дом"])[0]
    timed = replace(raw, end=1.22, score=0.99 if evidence == "reliable-consonant" else raw.score)
    activity = np.ones(170, bool)
    if evidence == "pause-before-echo":
        activity[60:90] = False
    heard = {} if evidence == "no-independent-end" else {0: (0.2, 1.22)}

    assert with_sung_letters([timed], scores, 0.02, activity, heard) == [timed]


def test_terminal_consonant_evidence_is_not_diluted_by_a_long_word() -> None:
    from dataclasses import replace

    text = "неудовлетворительность"
    tokens = [token for character in _character_tokens(text) for token in character]
    frames = (*range(10, 10 + 2 * (len(tokens) - 1), 2), 80)
    probabilities, _ = _probabilities(text, frames)
    _weak_early_consonant(probabilities, tokens[-1], frames[-2] + 2)
    scores = probabilities.log()
    raw = align_words(scores, 0.02, [text])[0]
    timed = replace(raw, end=1.62)
    assert 0.95 - raw.score < 0.05

    fixed = with_sung_letters([timed], scores, 0.02, np.ones(170, bool), {0: (0.2, 1.62)})[0]

    assert fixed.letters[-2:] == pytest.approx((1.6, 1.62))
    assert fixed.letters[:-2] == timed.letters[:-2]
    assert (fixed.start, fixed.end) == (timed.start, timed.end)
