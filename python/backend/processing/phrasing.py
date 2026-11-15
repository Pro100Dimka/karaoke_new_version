from __future__ import annotations

import math
from itertools import pairwise
from typing import Sequence

from backend.ai.domain import WordTiming


def _phrase_lines(
    lyrics: str,
    words: Sequence[WordTiming],
    activity: Sequence[tuple[float, float]],
    bpm: float | None = None,
) -> str:
    """Persist readable phrases at written boundaries, breaths, and the eight-word limit."""
    pause_seconds = (
        max(0.2, min(0.35, 30 / bpm)) if bpm and math.isfinite(bpm) and bpm > 0 else 0.35
    )
    boundaries: set[int] = set()
    count = 0
    for line in lyrics.splitlines():
        count += len(line.split())
        boundaries.add(count)
    written = [word for word in words if "RecoveredVocalization" not in word.diagnostics]
    if count != len(written):
        return lyrics
    boundaries.update(_confirmed_phrase_breaks(written, boundaries, pause_seconds))
    pauses = [
        (left[1], right[0])
        for left, right in pairwise(activity)
        if right[0] - left[1] >= pause_seconds
    ]
    lines = _laid_out_phrases(words, boundaries, pauses, pause_seconds)
    _join_short_prefixes(lines)
    return "\n".join(" ".join(word.text for word in line) for line in lines)


def _phrase_contexts(
    written: Sequence[WordTiming],
    boundaries: set[int],
) -> dict[int, tuple[int, tuple[str, ...]]]:
    contexts: dict[int, tuple[int, tuple[str, ...]]] = {}
    first = 0
    for last in sorted(boundaries):
        for index in range(max(1, first), last):
            # A saved row entry still needs its preceding words to identify repeated replies.
            left = max(first if index > first else 0, index - 2)
            contexts[index] = (
                index - left,
                tuple(word.text.casefold() for word in written[left : min(last, index + 2)]),
            )
        first = last
    return contexts


def _confirmed_phrase_breaks(
    written: Sequence[WordTiming],
    boundaries: set[int],
    pause_seconds: float,
) -> set[int]:
    contexts = _phrase_contexts(written, boundaries)
    confirmed_breaks = {
        context
        for index, context in contexts.items()
        # An uncertain local alignment must not fragment every repeated phrase.
        if all(
            {
                "TimingReviewRequired",
                "AsrCtcBoundaryDisagreement",
                "ApproximateAlignment",
            }.isdisjoint(word.diagnostics)
            for word in written[index - 1 : index + 1]
        )
        and (
            written[index].start - written[index - 1].end >= pause_seconds
            or "RecognizedPhraseEntry" in written[index].diagnostics
        )
    }
    return {index for index, context in contexts.items() if context in confirmed_breaks}


def _join_short_prefixes(lines: list[list[WordTiming]]) -> None:
    for index in range(len(lines) - 2, -1, -1):
        if len(lines[index]) == 1 and lines[index][0].text.casefold() in {
            "в",
            "у",
            "з",
            "с",
            "к",
            "a",
            "an",
            "the",
            "to",
            "of",
            "in",
        }:
            previous = lines[index][0]
            if previous.end - previous.start < 0.8 and lines[index + 1][0].start - previous.end < 3:
                lines[index + 1].insert(0, previous)
                lines.pop(index)


def _starts_phrase(
    word: WordTiming,
    previous: WordTiming,
    previous_index: int,
    written_index: int,
    boundaries: set[int],
    pauses: Sequence[tuple[float, float]],
    row_length: int,
    pause_seconds: float,
) -> bool:
    return (
        any(previous_index < boundary <= written_index for boundary in boundaries)
        or "RecoveredVocalization" in word.diagnostics
        or "RecoveredVocalization" in previous.diagnostics
        or "RecognizedPhraseEntry" in word.diagnostics
        or row_length >= 8
        or word.start - previous.end >= pause_seconds
        or any(
            previous.start < start < word.start and end <= word.start + 0.15
            for start, end in pauses
        )
    )


def _laid_out_phrases(
    words: Sequence[WordTiming],
    boundaries: set[int],
    pauses: Sequence[tuple[float, float]],
    pause_seconds: float,
) -> list[list[WordTiming]]:
    lines: list[list[WordTiming]] = []
    written_index = 0
    previous_index = -1
    previous: WordTiming | None = None
    for word in words:
        vocalization = "RecoveredVocalization" in word.diagnostics
        if "BackingVocalOverlap" in word.diagnostics:
            written_index += not vocalization
            continue
        if previous is None or _starts_phrase(
            word,
            previous,
            previous_index,
            written_index,
            boundaries,
            pauses,
            len(lines[-1]),
            pause_seconds,
        ):
            lines.append([])
        lines[-1].append(word)
        previous, previous_index = word, written_index
        written_index += not vocalization
    return lines
