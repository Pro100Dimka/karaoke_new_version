from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import replace
import numpy as np
from whisper.audio import CHUNK_LENGTH
from backend.ai_worker.ctc import AlignedWord, Window, _PREFERENCE, _evenly, ordered
from backend.ai_worker.guidance_phrases import _key, recognized_phrase, heard_words

_MARGIN = 0.6
_STEP = 0.01
HeardWord = tuple[str, float, float]


def backing_overlap_indices(
    words: Sequence[AlignedWord],
    views: Sequence[list[HeardWord]],
    activity: np.ndarray,
    periodicity: np.ndarray,
    *,
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]]
    | None = None,
    lead_entries: dict[int, float] | None = None,
) -> frozenset[int]:
    """Keep solo replies, excluding extra words that obstruct an independently heard lead."""
    if len(views) < 2:
        return frozenset()
    known = {_key(word.text) for word in words if "AcousticRepeatRetimed" in word.diagnostics}
    backing = set()
    for index, word in enumerate(words):
        entry = _backing_entry(index, words, views, activity, periodicity, known, recognize)
        if entry is not None:
            backing.add(index)
            if lead_entries is not None and _displaced_lead(
                word, words[index + 1 : index + 5], views
            ):
                lead_entries[index + 1] = entry
    return frozenset(backing)


def _displaced_lead(
    word: AlignedWord,
    phrase: Sequence[AlignedWord],
    views: Sequence[list[HeardWord]],
) -> bool:
    return any(
        key == _key(phrase[0].text)
        and start + _MARGIN <= phrase[0].start
        and start < word.start
        and end >= word.end
        for view in views
        for key, start, end in view
    )


def _backing_entry(
    index: int,
    words: Sequence[AlignedWord],
    views: Sequence[list[HeardWord]],
    activity: np.ndarray,
    periodicity: np.ndarray,
    known: set[str],
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]] | None,
) -> float | None:
    word, phrase = words[index], words[index + 1 : index + 5]
    if "AcousticRepeatRetimed" in word.diagnostics or len(phrase) < 3:
        return None
    displaced = _displaced_lead(word, phrase, views)
    if not displaced and (
        _key(word.text) not in known or word.score > _PREFERENCE or word.end - word.start < 0.25
    ):
        return None
    first, last = max(0, round(word.start / _STEP)), min(len(activity), round(word.end / _STEP))
    if (
        not displaced
        and np.count_nonzero(activity[first:last] & (periodicity[first:last] >= 0.7)) >= 10
    ):
        return None
    window = Window(
        index + 1, index + 1 + len(phrase), word.start, phrase[-1].end + _MARGIN, phrase[0].start
    )
    texts = [item.text for item in phrase]
    matches = [(view, recognized_phrase(window, texts, view, _MARGIN)[1]) for view in views]
    context = _backing_context(index, words, phrase, window, matches)
    if context is None:
        return None
    agreed = _lead_agreement(word, phrase, window, matches, context, displaced, recognize)
    return (
        float(np.median(agreed))
        if len(agreed) == len(views) and max(agreed) - min(agreed) <= _MARGIN
        else None
    )


def _local_lead_match(
    word: AlignedWord,
    phrase: Sequence[AlignedWord],
    window: Window,
    context: tuple[float, float],
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]],
) -> dict[int, tuple[float, float]] | None:
    try:
        results = recognize([(*context, None)]).get("contexts", [])
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return None
    local = (
        heard_words(results[0])
        if isinstance(results, list) and results and isinstance(results[0], dict)
        else []
    )
    if _contains_word(word, local):
        return None
    return recognized_phrase(window, [item.text for item in phrase], local, _MARGIN)[1]


def _contains_word(word: AlignedWord, view: Sequence[HeardWord]) -> bool:
    return any(
        key == _key(word.text) and start < word.end and end > word.start for key, start, end in view
    )


def _lead_agreement(
    word: AlignedWord,
    phrase: Sequence[AlignedWord],
    window: Window,
    matches: Sequence[tuple[list[HeardWord], dict[int, tuple[float, float]]]],
    context: tuple[float, float],
    displaced: bool,
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]] | None,
) -> list[float]:
    agreed = []
    replaced_view = False
    for view, intervals in matches:
        tolerance = 0.0
        if _contains_word(word, view):
            break
        lead = intervals.get(window.first)
        if (lead is None or len(intervals) < 2) and recognize is not None and not replaced_view:
            local = _local_lead_match(word, phrase, window, context, recognize)
            if local is None:
                break
            intervals, replaced_view, tolerance = local, True, _MARGIN
            lead = intervals.get(window.first)
        if (
            lead is None
            or len(intervals) < 2
            or not _lead_overlaps(word, phrase, lead, displaced, tolerance)
        ):
            break
        agreed.append(lead[0] if displaced else max(word.start, lead[0] - tolerance))
    return agreed


def _lead_overlaps(
    word: AlignedWord,
    phrase: Sequence[AlignedWord],
    lead: tuple[float, float],
    displaced: bool,
    tolerance: float,
) -> bool:
    if displaced and not (
        lead[0] + _MARGIN <= phrase[0].start and lead[0] < word.start and lead[1] >= word.end
    ):
        return False
    overlap = max(0.0, min(word.end, lead[1]) - max(word.start, lead[0] - tolerance))
    return overlap >= (word.end - word.start) / 2


def with_lead_vocals(
    words: list[AlignedWord],
    views: Sequence[list[HeardWord]],
    activity: np.ndarray,
    periodicity: np.ndarray,
    *,
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]]
    | None = None,
) -> list[AlignedWord]:
    entries: dict[int, float] = {}
    backing = backing_overlap_indices(
        words, views, activity, periodicity, recognize=recognize, lead_entries=entries
    )
    if not backing:
        return words
    lead = ordered(
        [
            replace(
                word,
                start=entries[index],
                letters=_evenly([word.text], entries[index], word.end)[0].letters,
                diagnostics=(*word.diagnostics, "IndependentLeadEntry", "ApproximateLetterTiming"),
            )
            if index in entries
            else word
            for index, word in enumerate(words)
            if index not in backing
        ]
    )
    remaining = iter(lead)
    return [
        replace(word, diagnostics=(*word.diagnostics, "BackingVocalOverlap"))
        if index in backing
        else next(remaining)
        for index, word in enumerate(words)
    ]


def _backing_context(
    index: int,
    words: Sequence[AlignedWord],
    phrase: Sequence[AlignedWord],
    window: Window,
    matches: Sequence[tuple[list[HeardWord], dict[int, tuple[float, float]]]],
) -> tuple[float, float] | None:
    supported = [
        intervals for _, intervals in matches if index + 1 in intervals and len(intervals) >= 2
    ]
    if not supported:
        return None
    end = min(
        window.end, max(end for intervals in supported for _, end in intervals.values()) + _MARGIN
    )
    start = max(0.0, end - CHUNK_LENGTH, words[max(0, index - len(phrase))].start - _MARGIN)
    return start, end
