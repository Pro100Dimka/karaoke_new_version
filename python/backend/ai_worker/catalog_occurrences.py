from __future__ import annotations

from collections.abc import Sequence

from backend.ai_worker.ctc import Window
from backend.ai_worker.guidance_phrases import HeardWord, recognized_phrase


def recognized_occurrences(
    lines: Sequence[tuple[int, float, str]],
    heard: Sequence[HeardWord],
    shift: float,
    margin: float,
) -> dict[int, tuple[float, float]]:
    """Reserve fully recognized phrases at their original, globally corrected cues.

    Partial spelling support cannot establish ownership of a whole occurrence.
    Use character intervals, without search margins, so adjacent repeats remain distinct.
    """
    result: dict[int, tuple[float, float]] = {}
    total = max((end for _, _, end in heard), default=0.0)
    for index, (first, start, text) in enumerate(lines):
        words, entry = text.split(), start + shift
        end = lines[index + 1][1] + shift if index + 1 < len(lines) else total
        window = Window(first, first + len(words), max(0.0, entry - margin), end + margin, entry)
        _, local = recognized_phrase(window, words, heard, margin)
        if local and len(local) == len(words):
            result[index] = (
                min(start for start, _ in local.values()),
                max(end for _, end in local.values()),
            )
    return result
