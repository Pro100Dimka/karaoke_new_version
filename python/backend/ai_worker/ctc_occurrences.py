from __future__ import annotations

from collections.abc import Mapping, Sequence
from math import isfinite

from backend.ai_worker.ctc_domain import (
    AlignedWord,
    Window,
    _HEARD_DISAGREEMENT_SECONDS,
    _PREFERENCE,
)


def displaced_prefix(
    words: Sequence[AlignedWord],
    window: Window,
    timings: Mapping[int, tuple[float, float]],
) -> tuple[int, int] | None:
    """Locate an unambiguous measured prefix belonging to a later exact word run."""
    choices = []
    for target in range(3, len(words) - 2):
        limit = min(target, len(words) - target)
        size = next(
            (
                offset
                for offset in range(limit)
                if not _owned_word(words, offset, target, window, timings)
            ),
            limit,
        )
        keys = {
            "".join(char.casefold() for char in word.text if char.isalnum())
            for word in words[:size]
        }
        if size < 3 or len(keys - {""}) < 3:
            continue
        if not _ordered_evidence(timings, window.first, target + size):
            continue
        if any(char.isdigit() for word in words[:target] for char in word.text):
            continue
        if any(
            word.score > _PREFERENCE and _fits(word, timings[window.first + index])
            for index, word in enumerate(words[: target + size])
        ):
            continue
        if target + size < len(words) and words[size - 1].end > words[target + size].start:
            continue
        choices.append((target, size))
    return choices[0] if len(choices) == 1 else None


def _owned_word(
    words: Sequence[AlignedWord],
    offset: int,
    target: int,
    window: Window,
    timings: Mapping[int, tuple[float, float]],
) -> bool:
    word, following = words[offset], words[target + offset]
    own, heard = timings.get(window.first + offset), timings.get(window.first + target + offset)
    return (
        own is not None
        and heard is not None
        and word.score > _PREFERENCE
        and len(word.letters) == len(word.text)
        and tuple(char.casefold() for char in word.text)
        == tuple(char.casefold() for char in following.text)
        and word.start > own[1] + _HEARD_DISAGREEMENT_SECONDS
        and _fits(word, heard)
        and window.start <= word.start < word.end <= window.end
        and (offset == 0 or words[offset - 1].end <= word.start)
    )


def _fits(word: AlignedWord, interval: tuple[float, float]) -> bool:
    return (
        interval[0] - _HEARD_DISAGREEMENT_SECONDS <= word.start < interval[1]
        and word.end <= interval[1] + _HEARD_DISAGREEMENT_SECONDS
    )


def _ordered_evidence(timings: Mapping[int, tuple[float, float]], first: int, count: int) -> bool:
    previous = float("-inf")
    for index in range(first, first + count):
        interval = timings.get(index)
        if interval is None or not all(isfinite(value) for value in interval):
            return False
        start, end = interval
        if not 0 <= start < end or start < previous:
            return False
        previous = end
    return True


def usable_prefix(
    words: Sequence[AlignedWord], expected: Sequence[AlignedWord], window: Window, step: float
) -> bool:
    """An unusable crop cannot replace measured cores with proportional interpolation."""
    return len(words) == len(expected) and all(
        word.text == original.text
        and word.score > 0
        and window.start - step <= word.start < word.end <= window.end + 1e-9
        for word, original in zip(words, expected, strict=True)
    )
