from __future__ import annotations

from collections.abc import Sequence
from difflib import SequenceMatcher
from math import isfinite

from backend.ai_worker.asr_candidates import _MINIMUM_BLOCK, _orthographic_key
from backend.ai_worker.asr_views import token_key

HeardWord = tuple[str, float, float]


def preserve_prefix(
    original: str,
    recovered: str,
    previous: Sequence[HeardWord],
    selected: list[HeardWord],
) -> list[HeardWord]:
    """Keep an observed prefix lost when recovered lyrics select another guide.

    This combines timing hints only. It must never become another raw recognition
    view or supply an independent vote for recovering or replacing written words.
    """
    if original == recovered or not previous or not selected or previous is selected:
        return selected
    matched = _prefix(original, recovered, previous, selected)
    if matched is None:
        return selected
    retained, following = matched
    if (
        not _valid(retained)
        or not _valid(following)
        or retained[-1][2] > following[0][1]
        or any(
            max(first, other_first) < min(last, other_last)
            for _, first, last in retained
            for _, other_first, other_last in selected
        )
    ):
        return selected
    return sorted([*selected, *retained], key=lambda word: (word[1], word[2]))


def _prefix(
    original: str,
    recovered: str,
    previous: Sequence[HeardWord],
    selected: Sequence[HeardWord],
) -> tuple[Sequence[HeardWord], Sequence[HeardWord]] | None:
    written = [token_key(word) for word in recovered.split()]
    spelled = [_orthographic_key(word) for word in recovered.split()]
    observed = [_orthographic_key(word) for word, _, _ in selected]
    blocks = SequenceMatcher(a=spelled, b=observed, autojunk=False).get_matching_blocks()
    anchor = next((block for block in blocks if block.size), None)
    if anchor is None or anchor.a == 0 or anchor.size < _MINIMUM_BLOCK:
        return None
    prefix = written[: anchor.a]
    previous_keys = [token_key(word) for word, _, _ in previous]
    positions = _occurrences(prefix, previous_keys)
    anchor_keys = spelled[anchor.a : anchor.a + anchor.size]
    if (
        [token_key(word) for word in original.split()][: anchor.a] != prefix
        or _occurrences(prefix, written) != [0]
        or len(positions) != 1
        or _occurrences(prefix, [token_key(word) for word, _, _ in selected])
        or _occurrences(anchor_keys, spelled) != [anchor.a]
        or _occurrences(anchor_keys, observed) != [anchor.b]
    ):
        return None
    retained = previous[positions[0] : positions[0] + len(prefix)]
    following = selected[anchor.b : anchor.b + anchor.size]
    return retained, following


def _occurrences(needle: Sequence[str], words: Sequence[str]) -> list[int]:
    return [
        index
        for index in range(len(words) - len(needle) + 1)
        if words[index : index + len(needle)] == needle
    ]


def _valid(words: Sequence[HeardWord]) -> bool:
    return all(
        token_key(text) and isfinite(first) and isfinite(last) and 0 <= first < last
        for text, first, last in words
    ) and all(left[2] <= right[1] for left, right in zip(words, words[1:]))
