from __future__ import annotations

from collections.abc import Mapping, Sequence
from math import ceil, floor

import torch

from backend.ai_worker.ctc_domain import (
    AlignedWord,
    Window,
    _HEARD_DISAGREEMENT_SECONDS,
    _PREFERENCE,
)
from backend.ai_worker.ctc_tokens import _character_tokens


def preserve_following_core(
    candidates: list[list[AlignedWord]],
    reference: list[AlignedWord],
    whole: Sequence[AlignedWord],
    window: Window,
    anchors: Mapping[int, float],
    scores: torch.Tensor,
    step: float,
) -> list[list[AlignedWord]]:
    """A weak unheard tail cannot improve by taking the next confirmed whole-song core."""
    anchor = anchors.get(window.last)
    if (
        not any(candidate is reference for candidate in candidates)
        or window.last >= len(whole)
        or window.last - 1 in anchors
        or reference[-1].score > _PREFERENCE
        or anchor is None
    ):
        return candidates
    following = whole[window.last]
    if (
        following.score <= _PREFERENCE
        or abs(following.start - anchor) > _HEARD_DISAGREEMENT_SECONDS
        or reference[-1].end > following.start + 1e-9
    ):
        return candidates
    return (
        [reference]
        if any(
            _covers_supported_prefix(candidate[-1], following, scores, step)
            for candidate in candidates
            if candidate is not reference
        )
        else candidates
    )


def _covers_supported_prefix(
    tail: AlignedWord, following: AlignedWord, scores: torch.Tensor, step: float
) -> bool:
    if (
        tail.end <= following.start
        or tail.start >= following.end
        or len(following.letters) != len(following.text)
        or any(char.isdigit() for char in following.text)
        or scores.ndim != 2
        or step <= 0
    ):
        return False
    tokens = _character_tokens(following.text)
    # A displayed letter may cover several phonemes; keep the prior choice when
    # its individual phoneme intervals cannot be recovered from the letter bounds.
    if any(len(part) > 1 for part in tokens):
        return False
    ends = (*following.letters[1:], following.end)
    for moment, end, part in zip(following.letters, ends, tokens, strict=True):
        first = ceil(max(moment, tail.start) / step - 1e-9)
        stop = floor(min(end, tail.end) / step + 1e-9)
        if (
            len(part) == 1
            and 0 <= first < stop <= len(scores)
            and float(scores[first:stop, part[0]].exp().max()) > _PREFERENCE
        ):
            return True
    return False
