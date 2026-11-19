from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace

import numpy as np
import torch

from backend.ai_worker import ctc


def _phrase_timings(
    heard: Mapping[int, tuple[float, float]], local: Mapping[int, tuple[float, float]]
) -> dict[int, tuple[float, float]]:
    """A partial fuzzy repeat cannot move a known word behind its retained predecessor."""
    result = dict(heard)
    for index, interval in sorted(local.items()):
        previous, known = result.get(index - 1), heard.get(index)
        if known is not None and previous is not None and interval[0] < previous[0] <= known[0]:
            continue
        result[index] = interval
    return result


def _clips_supported_anchor(
    word: ctc.AlignedWord,
    end: float,
    scores: torch.Tensor | None,
    step: float | None,
) -> bool:
    """Protect the clipped phoneme, rather than borrowing support from an earlier letter."""
    if (
        scores is None
        or step is None
        or len(word.letters) != len(word.text)
        or not any(character.isalpha() for character in word.text)
    ):
        return ctc._clips_letter_anchor(word, end)
    for index, (char, moment, tokens) in enumerate(
        zip(word.text, word.letters, ctc._character_tokens(word.text), strict=True)
    ):
        if (
            not char.isalnum()
            or char.casefold() in "ьъ"
            or not end - 1e-9 <= moment < word.end - 1e-9
        ):
            continue
        following = word.letters[index + 1] if index + 1 < len(word.letters) else word.end
        first, stop = round(moment / step), round(following / step)
        # A letter can expand to several phonemes, and numbers need phrase language.
        # Keep the existing protection when a single-token check cannot establish support.
        if len(tokens) != 1 or not 0 <= first < stop <= len(scores):
            return True
        # A CTC token may become strong after its first frame within the letter's own span.
        if float(scores[first:stop, tokens[0]].exp().max()) > ctc._PREFERENCE:
            return True
    return False


def _bridge_candidates(
    options: Sequence[Sequence[ctc.AlignedWord]],
    scores: torch.Tensor,
    step: float,
    voiced: np.ndarray,
) -> list[tuple[int, ctc.AlignedWord]]:
    """Fit a weak middle word without sacrificing either supported neighbour.

    Independent crops can put the middle word on the preceding word's suffix.
    Rejecting that overlap must not force the following supported core to move.
    Offer a real CTC path in the remaining gap, preserving the uncertainty and
    the existing limit on newly crammed words.
    """
    additions: list[tuple[int, ctc.AlignedWord]] = []
    for index in range(1, len(options) - 1):
        if any(word.score > ctc._PREFERENCE for word in options[index]):
            continue
        for before in options[index - 1]:
            if before.score <= ctc._PREFERENCE:
                continue
            for after in options[index + 1]:
                if after.score <= ctc._PREFERENCE or not before.end < after.start:
                    continue
                if not any(
                    before.start < middle.start < after.start
                    and middle.end <= after.start
                    and ctc._clips_letter_anchor(before, middle.start)
                    for middle in options[index]
                ):
                    continue
                candidate = _fit_bridge(
                    options[index][0], before.end, after.start, scores, step, voiced
                )
                if (
                    candidate is not None
                    and candidate not in options[index]
                    and (index, candidate) not in additions
                ):
                    additions.append((index, candidate))
    return additions


def _fit_bridge(
    original: ctc.AlignedWord,
    start: float,
    end: float,
    scores: torch.Tensor,
    step: float,
    voiced: np.ndarray,
) -> ctc.AlignedWord | None:
    candidate = ctc._align_window(scores, step, [original.text], ctc.Window(0, 1, start, end))[0]
    if (
        candidate.score <= 0
        or candidate.start < start
        or candidate.end > end
        or ctc._implausible([candidate], voiced) > ctc._implausible([original], voiced)
    ):
        return None
    if candidate.score <= ctc._PREFERENCE:
        candidate = replace(
            candidate,
            diagnostics=tuple(dict.fromkeys((*candidate.diagnostics, "TimingReviewRequired"))),
        )
    return candidate
