from __future__ import annotations
from bisect import bisect_left
from collections.abc import Mapping, Sequence
from dataclasses import replace
import numpy as np
from backend.ai_worker import ctc


_REVIEW_MAX_WORDS = 12
_REVIEW_MAX_SECONDS = 8.0


def _review_windows(
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    reviewed: frozenset[int],
    margin: float,
    total: float,
    *,
    voiced: np.ndarray | None = None,
    onsets: Sequence[float] = (),
) -> list[ctc.Window]:
    """Plan disjoint local repairs; an indivisible sustained word may exceed the time cap."""
    ranges: list[tuple[int, int]] = []
    targets = sorted(index for index in reviewed if 0 <= index < len(words))
    for index in targets:
        first, last = max(0, index - 1), min(len(words), index + 2)
        if ranges and first < ranges[-1][1]:
            ranges[-1] = ranges[-1][0], max(ranges[-1][1], last)
        else:
            ranges.append((first, last))
    result: list[ctc.Window] = []
    cursor = 0
    for first, last in ranges:
        final = targets[bisect_left(targets, last) - 1]
        while cursor < len(targets) and targets[cursor] < last:
            target = targets[cursor]
            first = max(first, target - 1)
            context = _review_window(words, heard, first, target + 1, margin, total)
            if first < target and context.end - context.start > _REVIEW_MAX_SECONDS:
                first = target
            stop = _review_stop(
                words, heard, reviewed, first, last, target, margin, total, voiced, onsets, final
            )
            result.append(_review_window(words, heard, first, stop, margin, total))
            first = stop
            cursor = bisect_left(targets, stop, cursor + 1)
    result = _separate_review_audio(result, words, heard, reviewed, voiced, onsets)
    result = _coalesce_review_windows(result, frozenset(first for first, _ in ranges))
    return _review_context(result, words, onsets)


def _review_context(
    windows: Sequence[ctc.Window],
    words: Sequence[ctc.AlignedWord],
    onsets: Sequence[float],
) -> list[ctc.Window]:
    """Expose bounded acoustic context for approximate entries in the window plan."""
    result: list[ctc.Window] = []
    cursor = 0.0
    for window in windows:
        if words[window.first].score <= 0:
            # Prior accepted cores stay inside their window; cursor protects them too.
            before = words[window.first - 1].end if window.first else 0.0
            floor = max(
                cursor,
                before,
                window.start - ctc._CONTEXT_SECONDS,
                window.end - _REVIEW_MAX_SECONDS,
            )
            entry = min((at for at in onsets if floor <= at < window.start), default=None)
            if entry is not None:
                window = replace(window, start=max(floor, entry - ctc._ONSET_SEARCH_BEFORE_SECONDS))
        result.append(window)
        cursor = window.end
    return result


def _coalesce_review_windows(
    windows: Sequence[ctc.Window], joins: frozenset[int]
) -> list[ctc.Window]:
    """Pack complete adjacent contexts, preserving chosen acoustic cuts and all audio gaps."""
    result: list[ctc.Window] = []
    for window in windows:
        if (
            result
            and window.first in joins
            and result[-1].last == window.first
            and result[-1].end == window.start
            and window.last - result[-1].first <= _REVIEW_MAX_WORDS
            and window.end - result[-1].start <= _REVIEW_MAX_SECONDS
        ):
            result[-1] = replace(result[-1], last=window.last, end=window.end)
        else:
            result.append(window)
    return result


def _review_stop(
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    reviewed: frozenset[int],
    first: int,
    last: int,
    target: int,
    margin: float,
    total: float,
    voiced: np.ndarray | None,
    onsets: Sequence[float],
    last_target: int,
) -> int:
    stops = [
        stop
        for stop in range(target + 1, min(last, first + _REVIEW_MAX_WORDS) + 1)
        if stop == first + 1
        or (candidate := _review_window(words, heard, first, stop, margin, total)).end
        - candidate.start
        <= _REVIEW_MAX_SECONDS
    ]
    stop = max(stops)
    if stop < last and last_target >= stop:
        return max(
            (boundary for boundary in stops if boundary >= min(target + 2, stop)),
            key=lambda boundary: (
                _review_boundary(words, heard, reviewed, boundary, voiced, onsets)[0],
                boundary,
            ),
        )
    return stop


def _separate_review_audio(
    windows: list[ctc.Window],
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    reviewed: frozenset[int],
    voiced: np.ndarray | None,
    onsets: Sequence[float],
) -> list[ctc.Window]:
    for index in range(1, len(windows)):
        left, right = windows[index - 1], windows[index]
        if left.last == right.first or left.end > right.start:
            _, boundary = _review_boundary(words, heard, reviewed, right.first, voiced, onsets)
            # Even an unsafe seam must not repeat audio; its proposals cannot pass the commit check.
            windows[index - 1] = replace(left, end=min(left.end, boundary))
            windows[index] = replace(right, start=max(right.start, boundary))
    return windows


def _review_window(
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    first: int,
    last: int,
    margin: float,
    total: float,
) -> ctc.Window:
    start = min(words[first].start, heard.get(first, (words[first].start, 0))[0])
    end = max(words[last - 1].end, heard.get(last - 1, (0, words[last - 1].end))[1])
    # Conflicting outside cores cannot anchor a crop. They still veto an unsupported commit.
    before = words[first - 1].end if first and words[first - 1].end <= words[first].start else 0.0
    after = (
        words[last].start
        if last < len(words) and words[last].start >= words[last - 1].end
        else total
    )
    return ctc.Window(
        first, last, max(0.0, before, start - margin), min(total, after, end + margin)
    )


def _review_boundary(
    words: Sequence[ctc.AlignedWord],
    heard: Mapping[int, tuple[float, float]],
    reviewed: frozenset[int],
    index: int,
    voiced: np.ndarray | None,
    onsets: Sequence[float],
) -> tuple[int, float]:
    """Prefer actual silence, corroborated entries, then unchanged context over a numeric cut."""
    start, end = words[index - 1].end, words[index].start
    middle = (start + end) / 2
    if start > end:
        return -1, middle
    step = ctc._VOICE_HOP / ctc._VOICE_RATE
    if voiced is not None:
        first, last = max(0, int(np.ceil(start / step))), min(len(voiced), int(end / step))
        quiet = np.diff(np.pad((~voiced[first:last]).astype(np.int8), (1, 1)))
        pauses = zip(np.flatnonzero(quiet == 1), np.flatnonzero(quiet == -1))
        pause = max(pauses, key=lambda span: span[1] - span[0], default=(0, 0))
        if (pause[1] - pause[0]) * step >= ctc._SILENT_START_SECONDS:
            return 3, float((first + (pause[0] + pause[1]) / 2) * step)
    if (
        index - 1 in heard
        and index in heard
        and heard[index - 1][1] <= heard[index][0]
        and abs(start - heard[index - 1][1]) <= ctc._HEARD_DISAGREEMENT_SECONDS
        and abs(end - heard[index][0]) <= ctc._HEARD_DISAGREEMENT_SECONDS
    ):
        return 2, middle
    entry = next(
        (
            onset
            for onset in onsets
            if start <= onset <= end and end - onset <= ctc._ONSET_SEARCH_BEFORE_SECONDS
        ),
        None,
    )
    if entry is not None:
        return 2, entry
    return int(index - 1 not in reviewed and index not in reviewed), middle
