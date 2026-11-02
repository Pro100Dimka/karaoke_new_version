from __future__ import annotations

from bisect import bisect_left
from collections.abc import Mapping, Sequence
from dataclasses import replace
import difflib
from difflib import SequenceMatcher

import numpy as np
import torch

from backend.ai_worker import ctc
from backend.lyrics.discovery import _line_matches, _lyrics_key


_REVIEW_MAX_WORDS = 12
_REVIEW_MAX_SECONDS = 8.0


def recognized_phrase(
    window: ctc.Window,
    words: Sequence[str],
    heard: Sequence[tuple[str, float, float]],
    margin: float,
    *,
    allow_utterance: bool = False,
) -> tuple[ctc.Window | None, dict[int, tuple[float, float]]]:
    """Use local phrase spelling support, including ASR splits and misspellings.

    Catalogue time selects the occurrence; the same character evidence used in lyric
    discovery selects its recognized span. It cannot add or replace any written text.
    """
    key = _lyrics_key(" ".join(words))
    best = _best_phrase_match(window, key, heard, margin)
    span = (
        best[1:]
        if best is not None
        else _nearby_utterance(window, heard, margin)
        if allow_utterance
        else None
    )
    if span is None or (window.heard_start is None and (best is None or best[0] < len(key) * 0.5)):
        return None, {}
    first, last = span
    phrase = replace(
        window,
        start=min(window.start, heard[first][1]) if best is not None else window.start,
        end=min(window.end, heard[last - 1][2] + margin),
        heard_start=window.heard_start if window.heard_start is not None else heard[first][1],
    )
    return phrase, _character_intervals(
        words, heard[first:last], window.first
    ) if best is not None else {}


def _best_phrase_match(
    window: ctc.Window,
    key: str,
    heard: Sequence[tuple[str, float, float]],
    margin: float,
) -> tuple[int, int, int] | None:
    keys = [_lyrics_key(word) for word, _, _ in heard]
    matches = [
        (support, first, last)
        for first, (_, start, _) in enumerate(heard)
        if window.start - margin <= start < min(window.end, window.start + 2 * margin)
        for last, support in _line_matches(key, keys, first)
        if heard[last - 1][1] < window.end and heard[last - 1][2] <= window.end + margin
    ]
    # Equal text support must keep the nearest occurrence, not the largest ASR index.
    entry = window.heard_start if window.heard_start is not None else window.start
    return max(
        matches,
        key=lambda match: (match[0], -abs(heard[match[1]][1] - entry)),
        default=None,
    )


def _nearby_utterance(
    window: ctc.Window,
    heard: Sequence[tuple[str, float, float]],
    margin: float,
) -> tuple[int, int] | None:
    starts = [
        index
        for index, (_, start, end) in enumerate(heard)
        if window.start - margin <= start < min(window.end, window.start + 2 * margin)
        and end <= window.end
    ]
    if not starts:
        return None
    first = min(
        starts, key=lambda index: abs(heard[index][1] - (window.heard_start or window.start))
    )
    last = first + 1
    while (
        last < len(heard)
        and heard[last][1] - heard[last - 1][2] <= margin
        and heard[last][2] <= window.end
    ):
        last += 1
    return first, last


def _character_intervals(
    words: Sequence[str],
    heard: Sequence[tuple[str, float, float]],
    first: int,
) -> dict[int, tuple[float, float]]:
    keys = [_lyrics_key(word) for word in words]
    written = [(char, first + index) for index, key in enumerate(keys) for char in key]
    spoken = [
        (
            char,
            (
                start + (end - start) * index / len(key),
                start + (end - start) * (index + 1) / len(key),
            ),
            (start, end),
        )
        for word, start, end in heard
        for key in [_lyrics_key(word)]
        for index, char in enumerate(key)
    ]
    intervals = _matched_positions(written, [char for char, _, _ in spoken])
    result: dict[int, tuple[float, float]] = {}
    for index, positions in intervals.items():
        precise = 2 * len(positions) > len(keys[index - first])
        spans = [
            part if precise else whole
            for position in positions
            for _, part, whole in [spoken[position]]
        ]
        result[index] = min(start for start, _ in spans), max(end for _, end in spans)
    for index, positions in intervals.items():
        if 2 * len(positions) <= len(keys[index - first]):
            start, end = result[index]
            result[index] = (
                max(start, result.get(index - 1, (start, start))[1]),
                min(end, result.get(index + 1, (end, end))[0]),
            )
            if result[index][1] <= result[index][0]:
                result[index] = (spoken[positions[0]][1][0], spoken[positions[-1]][1][1])
    return result


def _matched_positions(
    written: Sequence[tuple[str, int]],
    spoken: Sequence[str],
) -> dict[int, list[int]]:
    matches = SequenceMatcher(
        None, "".join(char for char, _ in written), "".join(spoken), autojunk=False
    ).get_matching_blocks()
    result: dict[int, list[int]] = {}
    for block in matches:
        for offset in range(block.size):
            index = written[block.a + offset][1]
            result.setdefault(index, []).append(block.b + offset)
    return result


def phrase_window(
    window: ctc.Window,
    phrase: ctc.Window | None,
    whole_start: float,
    last_heard: tuple[float, float] | None,
    margin: float,
) -> ctc.Window:
    """Combine independent phrase evidence without treating padded ASR as a voice entry.

    These bounds select phonetic cores only. Acoustic tail refinement still searches
    the full recording, including real vowels that continue beyond recognition.
    """
    entry = window.heard_start
    if entry is None:
        return window
    if (
        phrase is not None
        and phrase.heard_start is not None
        and window.start - margin <= phrase.heard_start < min(window.end, window.start + 2 * margin)
        and phrase.end > window.start
    ):
        return replace(
            window,
            start=min(window.start, phrase.start),
            end=min(window.end, phrase.end),
            heard_start=phrase.heard_start,
        )
    # A missing prefix must retain the catalogue entry. A supported last word can
    # nevertheless stop the alternative search borrowing the following instrumental break.
    if (
        last_heard is not None
        and abs(whole_start - entry) > margin
        and window.start <= last_heard[0] <= last_heard[1] <= window.end
        and entry <= last_heard[1]
    ):
        return replace(window, end=min(window.end, last_heard[1] + margin))
    return window


def with_word_guidance(
    words: list[ctc.AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    windows: Sequence[ctc.Window],
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    margin: float,
    *,
    recognized: Sequence[tuple[str, float, float]] = (),
    onsets: Sequence[float] = (),
    reviewed: frozenset[int] = frozenset(),
) -> list[ctc.AlignedWord]:
    if reviewed:
        return _reviewed_words(
            words, scores, frame_seconds, heard, voiced, margin, reviewed, onsets
        )
    result = list(words)
    for window in windows:
        phrase, local = recognized_phrase(
            window,
            [word.text for word in words[window.first : window.last]],
            recognized,
            margin,
            allow_utterance=window.first - 1 in heard and window.last in heard,
        )
        timings = local | dict(heard)
        first, last = max(0, window.first - 1), min(len(words), window.last + 1)
        options = [[word] for word in result[first:last]]
        alternatives = _recognized_cores(
            words, scores, frame_seconds, window, timings, voiced, margin, onsets, reviewed
        )
        if phrase is not None or any(window.first <= index < window.last for index in timings):
            # An unrecognized neighbour can occupy an earlier recognized word's real place.
            # Refit that gap between heard anchors too, so the joint choice can move both.
            alternatives += _unrecognized_runs(
                words, scores, frame_seconds, phrase or window, timings, voiced
            )
        for index, candidate, interval in alternatives:
            options[index - first].append(candidate)
            timings[index] = interval
        boundary = _boundary_pair(
            result, scores, frame_seconds, window, timings, voiced, margin, onsets
        )
        if boundary is not None:
            index, before, after = boundary
            options[index - first].append(before)
            options[index + 1 - first].append(after)
        result[first:last] = _select_sequence(
            result[first:last], options, timings, first, voiced, margin=margin, boundary=boundary
        )
    return [
        replace(word, diagnostics=(*word.diagnostics, "OnsetReviewRequired"))
        if "OnsetReviewRequired" not in word.diagnostics
        and _silent_prefix_entry(word, scores, frame_seconds, voiced) is not None
        else word
        for word in result
    ]


def _boundary_pair(
    words: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    step: float,
    window: ctc.Window,
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    margin: float,
    onsets: Sequence[float],
) -> tuple[int, ctc.AlignedWord, ctc.AlignedWord] | None:
    """Recover a weak phrase tail that borrowed the following word's opening tokens.

    Fit the following word independently with one stable neighbour, then use its
    entry as a CTC boundary. A coarse ASR endpoint alone cannot supply that boundary.
    """
    index = window.last - 1
    if window.first >= window.last or not 0 <= index < len(words) - 2:
        return None
    interval = heard.get(index)
    word = words[index]
    if interval is None or word.start - interval[0] <= margin:
        return None
    if _onset_confidence(word, scores, step) > ctc._PREFERENCE:
        return None
    after = _following_anchor(words[index + 1 : index + 3], scores, step, interval[0], margin)
    start = max(window.start, interval[0])
    if after is None or not start < after.start < word.end:
        return None
    candidate = _bounded_core(word, scores, step, (start, after.start), interval, voiced, onsets)
    return (index, candidate, after) if candidate is not None else None


def _following_anchor(
    following: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    step: float,
    start: float,
    margin: float,
) -> ctc.AlignedWord | None:
    """Find an independently supported entry while preserving its word's remaining context."""
    search = ctc.Window(
        0,
        len(following),
        max(start, following[0].start - margin),
        min(len(scores) * step, following[-1].end + margin),
    )
    if not 0 < search.end - search.start <= _REVIEW_MAX_SECONDS:
        return None
    after = ctc._align_window(scores, step, [w.text for w in following], search)
    if (
        not _stable_following_words(following, after, step)
        or after[0].score <= 0
        or after[0].score < following[0].score
        or abs(after[0].start - following[0].start) > ctc._HEARD_DISAGREEMENT_SECONDS
    ):
        return None
    return after[0]


def _bounded_core(
    word: ctc.AlignedWord,
    scores: torch.Tensor,
    step: float,
    bounds: tuple[float, float],
    interval: tuple[float, float],
    voiced: np.ndarray,
    onsets: Sequence[float],
) -> ctc.AlignedWord | None:
    """Keep the bounded CTC path and expose a weak cropped onset for review."""
    begin, end = (round(bound / step) for bound in bounds)
    if not 0 < (end - begin) * step <= _REVIEW_MAX_SECONDS:
        return None
    try:
        candidate = ctc.align_words(
            scores[begin:end], step, [word.text], begin * step, bounded_end=True
        )[0]
    except ValueError:
        return None
    if (
        candidate.score <= 0
        or word.start - interval[0] - abs(candidate.start - interval[0])
        <= ctc._HEARD_DISAGREEMENT_SECONDS
        or _onset_confidence(word, scores, step) > candidate.score + ctc._PREFERENCE
        or _crosses_confirmed_entry(word, candidate, interval, onsets)
        or ctc._implausible([candidate], voiced) > ctc._implausible([word], voiced)
    ):
        return None
    if (
        abs(candidate.start - begin * step) <= step
        and _onset_confidence(candidate, scores, step) <= ctc._PREFERENCE
    ):
        candidate = replace(
            candidate,
            diagnostics=(*candidate.diagnostics, "OnsetAtSearchBoundary", "TimingReviewRequired"),
        )
    return candidate


def _stable_following_words(
    original: Sequence[ctc.AlignedWord], candidates: Sequence[ctc.AlignedWord], step: float
) -> bool:
    """Only the following entry may move; its remaining letters and neighbour stay supported."""
    return len(original) == len(candidates) and all(
        abs(before.end - after.end) <= step + 1e-9
        and (index == 0 or abs(before.start - after.start) <= step + 1e-9)
        and len(before.letters) == len(after.letters)
        and all(
            abs(left - right) <= step + 1e-9
            for left, right in zip(
                before.letters[1 if index == 0 else 0 :],
                after.letters[1 if index == 0 else 0 :],
                strict=True,
            )
        )
        for index, (before, after) in enumerate(zip(original, candidates, strict=True))
    )


def _reviewed_words(
    words: list[ctc.AlignedWord],
    scores: torch.Tensor,
    step: float,
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    margin: float,
    reviewed: frozenset[int],
    onsets: Sequence[float] = (),
) -> list[ctc.AlignedWord]:
    """Refit disputed cores with their neighbours, using the existing full-audio emission."""
    result = list(words)
    for window in _review_windows(
        words, heard, reviewed, margin, scores.shape[0] * step, voiced=voiced, onsets=onsets
    ):
        if window.start >= window.end:
            # Coincident conflicting cores can leave no separate acoustic evidence; keep unresolved.
            continue
        original = words[window.first : window.last]
        candidates, onset = _review_candidates(
            original, scores, step, voiced, window, reviewed, heard, onsets
        )
        if len(candidates) != len(original) or (
            window.first
            and result[window.first - 1].end > min(original[0].start, candidates[0].start)
            or window.last < len(words)
            and max(original[-1].end, candidates[-1].end) > result[window.last].start
        ):
            # A work limit is not evidence for cutting an unresolved cross-window core.
            continue
        if any(
            index in heard and _crosses_confirmed_entry(before, after, heard[index], onsets)
            for index, (before, after) in enumerate(zip(original, candidates), window.first)
        ):
            continue
        if _supported_review(
            original, candidates, window.first, reviewed, heard, voiced, step, onset
        ):
            result[window.first : window.last] = candidates
    return result


def _review_candidates(
    original: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    step: float,
    voiced: np.ndarray,
    window: ctc.Window,
    reviewed: frozenset[int],
    heard: Mapping[int, tuple[float, float]],
    onsets: Sequence[float] = (),
) -> tuple[list[ctc.AlignedWord], bool]:
    """Crop a weak silent opening without retiming its supported phonetic context."""
    entry = (
        _silent_prefix_entry(original[0], scores, step, voiced)
        if window.first in reviewed
        else None
    )
    if entry is not None:
        # Padding with the same silence only selects the same stray CTC token again.
        window = replace(window, start=max(window.start, entry))
    candidates = ctc._align_window(scores, step, [w.text for w in original], window)
    if entry is None:
        candidates = _active_review_candidates(
            original, candidates, scores, step, voiced, window, reviewed, heard, onsets
        )
        return candidates, False
    if (
        not _stable_following_words(original, candidates, step)
        or not entry - step <= candidates[0].start < original[0].letters[1]
    ):
        return [], False
    # Preserve the supported suffix and neighbours, including crop-dependent frame jitter.
    opening = replace(
        original[0],
        start=candidates[0].start,
        letters=(candidates[0].start, *original[0].letters[1:]),
        score=candidates[0].score,
        diagnostics=tuple(flag for flag in original[0].diagnostics if flag != "OnsetReviewRequired")
        + ("OnsetRecovered",),
    )
    return [opening, *original[1:]], True


def _inactive_core(word: ctc.AlignedWord, voiced: np.ndarray) -> bool:
    step = ctc._VOICE_HOP / ctc._VOICE_RATE
    frames = voiced[max(0, int(word.start / step)) : round(word.end / step)]
    return word.score <= ctc._PREFERENCE and bool(len(frames)) and not frames.any()


def _active_replacement(
    before: ctc.AlignedWord, after: ctc.AlignedWord, voiced: np.ndarray
) -> bool:
    step = ctc._VOICE_HOP / ctc._VOICE_RATE
    frames = voiced[max(0, int(after.start / step)) : round(after.end / step)]
    return (
        (before.score <= 0 or _inactive_core(before, voiced))
        and after.score > before.score + ctc._PREFERENCE
        and bool(len(frames))
        and float(frames.mean()) >= 0.6
    )


def _active_review_candidates(
    original: Sequence[ctc.AlignedWord],
    candidates: list[ctc.AlignedWord],
    scores: torch.Tensor,
    step: float,
    voiced: np.ndarray,
    window: ctc.Window,
    reviewed: frozenset[int],
    heard: Mapping[int, tuple[float, float]],
    onsets: Sequence[float],
) -> list[ctc.AlignedWord]:
    """Choose an active replacement only after the complete sequence passes joint review."""
    result = list(candidates)
    if len(result) != len(original):
        return result
    if not _supported_review(original, result, window.first, reviewed, heard, voiced, step):
        result = list(original)
    for index, word in enumerate(original):
        if (
            window.first + index not in reviewed
            or not _inactive_core(word, voiced)
            or _active_replacement(word, result[index], voiced)
        ):
            continue
        start = max(window.start, result[index - 1].end if index else window.start)
        end = min(window.end, result[index + 1].start if index + 1 < len(result) else window.end)
        for proposal in _active_core_candidates(word, scores, step, voiced, onsets, (start, end)):
            sequence = [*result[:index], proposal, *result[index + 1 :]]
            if proposal.score > result[index].score and _supported_review(
                original, sequence, window.first, reviewed, heard, voiced, step
            ):
                result = sequence
    return result


def _active_core_candidates(
    word: ctc.AlignedWord,
    scores: torch.Tensor,
    step: float,
    voiced: np.ndarray,
    onsets: Sequence[float],
    bounds: tuple[float, float],
) -> list[ctc.AlignedWord]:
    """Try at most two existing rises inside the unchanged neighbours."""
    result: list[ctc.AlignedWord] = []
    for onset in _review_entries(word.text, scores, step, onsets, bounds):
        proposal = ctc._align_window(scores, step, [word.text], ctc.Window(0, 1, onset, bounds[1]))[
            0
        ]
        if (
            _active_replacement(word, proposal, voiced)
            and onset - step <= proposal.start <= onset + ctc._LARGEST_LAG_SECONDS
            and proposal.end <= bounds[1]
        ):
            result.append(replace(proposal, diagnostics=(*proposal.diagnostics, "OnsetRecovered")))
    return result


def _review_entries(
    text: str,
    scores: torch.Tensor,
    step: float,
    onsets: Sequence[float],
    bounds: tuple[float, float],
) -> list[float]:
    """Use existing opening-token evidence to bound the number of local CTC proposals."""
    tokens = next((part for part in ctc._character_tokens(text) if part), [])
    if not tokens:
        return []
    start, end = bounds
    entries: list[tuple[float, float]] = []
    for onset in sorted(set(onsets)):
        if not start <= onset < end:
            continue
        first = max(0, round(onset / step))
        last = min(len(scores), round(min(end, onset + ctc._LARGEST_LAG_SECONDS) / step))
        if first < last:
            support = float(scores[first:last, tokens[0]].exp().max())
            if support > ctc._PREFERENCE:
                entries.append((support, onset))
    return [onset for _, onset in sorted(entries, reverse=True)[:2]]


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


def _supported_review(
    original: Sequence[ctc.AlignedWord],
    candidates: Sequence[ctc.AlignedWord],
    first: int,
    reviewed: frozenset[int],
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    step: float,
    onset_recovered: bool = False,
) -> bool:
    if len(candidates) != len(original) or any(w.score <= 0 for w in candidates):
        return False
    if any(left.end > right.start for left, right in zip(candidates, candidates[1:])):
        return False
    changed = [
        index
        for index, (before, after) in enumerate(zip(original, candidates, strict=True))
        if max(abs(before.start - after.start), abs(before.end - after.end)) >= step / 2
        or before.letters != after.letters
    ]
    if not changed or any(
        candidates[i].score < original[i].score * (1 - ctc._PREFERENCE) for i in changed
    ):
        return False
    if any(
        not _review_anchor_supported(original[i], candidates[i], heard.get(first + i), voiced, step)
        for i in changed
    ):
        return False
    return _preserved_neighbours(original, candidates, first, reviewed, step) and (
        onset_recovered
        or _review_improves(original, candidates, changed, first, heard, voiced, step)
    )


def _review_anchor_supported(
    before: ctc.AlignedWord,
    after: ctc.AlignedWord,
    heard: tuple[float, float] | None,
    voiced: np.ndarray,
    step: float,
) -> bool:
    """Keep confirmed ASR/core guards; an approximate core needs active CTC evidence."""
    if before.score <= 0:
        return _active_replacement(before, after, voiced)
    return not (
        before.score > 0
        and heard is not None
        and abs(after.start - heard[0])
        > abs(before.start - heard[0]) + ctc._HEARD_DISAGREEMENT_SECONDS
        and not (
            _active_replacement(before, after, voiced)
            and heard[0] - step <= after.start
            and after.end <= heard[1] + step
        )
    )


def _preserved_neighbours(
    original: Sequence[ctc.AlignedWord],
    candidates: Sequence[ctc.AlignedWord],
    first: int,
    reviewed: frozenset[int],
    step: float,
) -> bool:
    """Keep unflagged boundaries unless an adjacent repaired core requires the move."""
    return not any(
        before.score > 0
        and first + index not in reviewed
        and (
            abs(before.start - after.start) > 2 * step
            and not (
                index > 0
                and before.start < candidates[index - 1].end
                and abs(after.start - candidates[index - 1].end) <= 2 * step + 1e-9
            )
            or abs(before.end - after.end) > 2 * step
            and not (
                index + 1 < len(candidates)
                and before.end > candidates[index + 1].start
                and abs(after.end - candidates[index + 1].start) <= 2 * step + 1e-9
            )
        )
        for index, (before, after) in enumerate(zip(original, candidates, strict=True))
    )


def _review_improves(
    original: Sequence[ctc.AlignedWord],
    candidates: Sequence[ctc.AlignedWord],
    changed: Sequence[int],
    first: int,
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    step: float,
) -> bool:
    before_fit, after_fit = (
        sum(
            abs(sequence[i].start - heard[first + i][0])
            + abs(sequence[i].end - heard[first + i][1])
            for i in changed
            if first + i in heard
        )
        for sequence in (original, candidates)
    )
    voice_step = ctc._VOICE_HOP / ctc._VOICE_RATE
    silent_before, silent_after = (
        sum(
            not voiced[max(0, int(w.start / voice_step)) : max(1, round(w.end / voice_step))].any()
            for w in sequence
        )
        for sequence in (original, candidates)
    )
    old, new = [original[i] for i in changed], [candidates[i] for i in changed]
    return silent_after <= silent_before and (
        after_fit + step < before_fit
        # The same changed words must contribute on both sides, including unaligned zeros.
        or sum(word.score for word in new) > sum(word.score for word in old) * (1 + ctc._PREFERENCE)
    )


def _recognized_cores(
    words: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    window: ctc.Window,
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    margin: float,
    onsets: Sequence[float] = (),
    reviewed: frozenset[int] = frozenset(),
) -> list[tuple[int, ctc.AlignedWord, tuple[float, float]]]:
    return [
        (index, candidate, interval)
        for index in range(window.first, window.last)
        if (interval := heard.get(index)) is not None
        for candidate in _candidates(
            words[index],
            scores,
            frame_seconds,
            window,
            interval,
            voiced,
            margin,
            onsets,
            review=index in reviewed,
        )
    ]


def _unrecognized_runs(
    words: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    window: ctc.Window,
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
) -> list[tuple[int, ctc.AlignedWord, tuple[float, float]]]:
    """Recheck missed words together between the independently recognized neighbours."""
    first, start = window.first, window.start
    result: list[tuple[int, ctc.AlignedWord, tuple[float, float]]] = []
    for index in range(window.first, window.last + 1):
        if index < window.last and index not in heard:
            continue
        end = heard[index][0] if index < window.last else window.end
        if first < index and start < end:
            gap = ctc.Window(
                first, index, start, end, window.heard_start if first == window.first else None
            )
            candidates = ctc._align_window(
                scores,
                frame_seconds,
                [w.text for w in words[first:index]],
                gap,
            )
            candidates = _settle_unrecognized_entry(candidates, gap, frame_seconds)
            for offset, candidate in enumerate(candidates):
                word = words[first + offset]
                if _onset_confidence(
                    word, scores, frame_seconds
                ) <= candidate.score + ctc._PREFERENCE and ctc._implausible(
                    [candidate], voiced
                ) <= ctc._implausible([word], voiced):
                    result.append((first + offset, candidate, (start, end)))
        first = index + 1
        start = heard[index][1] if index < window.last else window.end
    return result


def _settle_unrecognized_entry(
    words: list[ctc.AlignedWord],
    window: ctc.Window,
    frame_seconds: float,
) -> list[ctc.AlignedWord]:
    """A weak first-frame spike is a cropped search edge, not an independently heard entry."""
    if len(words) != window.last - window.first:
        return []
    first = words[0]
    entry = window.heard_start
    limit = words[1].start if len(words) > 1 else window.end
    if (
        entry is None
        or first.score > ctc._PREFERENCE
        or abs(first.start - window.start) > frame_seconds
        or not first.start < entry < limit
    ):
        return words
    return [ctc._evenly([first.text], entry, limit)[0], *words[1:]]


def _candidates(
    word: ctc.AlignedWord,
    scores: torch.Tensor,
    frame_seconds: float,
    window: ctc.Window,
    interval: tuple[float, float],
    voiced: np.ndarray,
    margin: float,
    onsets: Sequence[float] = (),
    *,
    review: bool = False,
) -> list[ctc.AlignedWord]:
    first, last = interval
    miss = abs(first - word.start)
    if miss <= ctc._HEARD_DISAGREEMENT_SECONDS and not review:
        return []
    candidates = [
        candidate
        for candidate in _core_candidates(
            word,
            scores,
            frame_seconds,
            window,
            interval,
            margin,
            review=review,
        )
        if (review or miss - abs(first - candidate.start) > ctc._HEARD_DISAGREEMENT_SECONDS)
        and (candidate.score > 0 or review or not first <= word.start <= last)
        and _onset_confidence(word, scores, frame_seconds) <= candidate.score + ctc._PREFERENCE
        and not _crosses_confirmed_entry(word, candidate, interval, onsets)
        and ctc._implausible([candidate], voiced) <= ctc._implausible([word], voiced)
    ]
    # Keep fallback available only when no acoustic candidate passed these guards.
    return [candidate for candidate in candidates if candidate.score > 0] or candidates


def _crosses_confirmed_entry(
    word: ctc.AlignedWord,
    candidate: ctc.AlignedWord,
    interval: tuple[float, float],
    onsets: Sequence[float],
) -> bool:
    """Do not move a core confirmed by a fresh vocal rise onto the preceding vowel.

    Recognition can include a preceding pause; a core outside its recognized
    phrase remains movable even if accompaniment has its own energy rise.
    """
    return interval[0] <= word.start <= interval[1] and any(
        candidate.start < onset <= word.start
        and word.start - onset <= ctc._ONSET_SEARCH_BEFORE_SECONDS
        for onset in onsets
    )


def _silent_prefix_entry(
    word: ctc.AlignedWord, scores: torch.Tensor, step: float, voiced: np.ndarray
) -> float | None:
    """Locate a weak stray opening using a later CTC token inside continuous activity.

    Activity includes unvoiced consonants. A held nasal/fricative or a strong
    quiet CTC opening cannot be discarded just because a later vowel is louder.
    """
    voice_step = ctc._VOICE_HOP / ctc._VOICE_RATE
    first = max(0, round(word.start / voice_step))
    if (
        len(word.letters) < 2
        or word.end - word.start < ctc._SILENCE_ENDS_WORD_SECONDS
        or voiced[first : first + round(ctc._SILENCE_ENDS_WORD_SECONDS / voice_step)].any()
        or _onset_confidence(word, scores, step) > ctc._PREFERENCE
    ):
        return None
    for moment, tokens in zip(word.letters[1:], ctc._character_tokens(word.text)[1:]):
        frame, anchor = round(moment / step), round(moment / voice_step)
        if (
            not tokens
            or not 0 <= frame < len(scores)
            or not first <= anchor < len(voiced)
            or not voiced[anchor]
            or float(scores[frame, tokens[0]].exp()) <= ctc._PREFERENCE
        ):
            continue
        active = np.flatnonzero(voiced[first : anchor + 1])
        entry = first + int(active[0])
        if not voiced[entry : anchor + 1].all():
            return None  # An intervening sound may be a real quiet opening, not padding.
        return entry * voice_step
    return None


def _onset_confidence(word: ctc.AlignedWord, scores: torch.Tensor, step: float) -> float:
    """Later correctly aligned letters cannot validate a misplaced opening phoneme."""
    # Number pronunciations need phrase language; retain their existing whole-word evidence.
    if not any(character.isalpha() for character in word.text):
        return word.score
    tokens = next((part for part in ctc._character_tokens(word.text) if part), [])
    frame = round(word.start / step)
    if not tokens or not 0 <= frame < scores.shape[0]:
        return word.score
    return min(word.score, float(scores[frame, tokens[0]].exp()))


def _core_candidates(
    word: ctc.AlignedWord,
    scores: torch.Tensor,
    frame_seconds: float,
    window: ctc.Window,
    interval: tuple[float, float],
    margin: float,
    *,
    review: bool = False,
) -> list[ctc.AlignedWord]:
    first, last = interval
    start, end = max(window.start, first), min(window.end, last + margin)
    if start >= end:
        return []
    candidates = ctc._align_window(
        scores,
        frame_seconds,
        [word.text],
        ctc.Window(0, 1, start, end),
    )
    end = min(last, window.end)
    if start < end and (review or not start <= word.start < end):
        # A recognition span can include the previous vowel. An interpolated entry
        # supplies no acoustic evidence against a CTC core already inside that span.
        candidates.extend(ctc._evenly([word.text], start, end))
    return candidates


def _select_sequence(
    original: list[ctc.AlignedWord],
    options: Sequence[Sequence[ctc.AlignedWord]],
    heard: Mapping[int, tuple[float, float]],
    first: int,
    voiced: np.ndarray,
    *,
    margin: float = 0.6,
    boundary: tuple[int, ctc.AlignedWord, ctc.AlignedWord] | None = None,
) -> list[ctc.AlignedWord]:
    """Choose word cores jointly; an improvement cannot crush or reverse a neighbour."""
    baseline = ctc.ordered(original)
    states: list[tuple[float, float, list[ctc.AlignedWord]]] = [(0.0, 0.0, [])]
    for index, choices in enumerate(options):
        following: list[tuple[float, float, list[ctc.AlignedWord]]] = []
        interval = heard.get(first + index)
        for word in choices:
            distance = _recognition_distance(word, interval, margin)
            paths = [
                (cost + distance, confidence - word.score, [*path, word])
                for cost, confidence, path in states
                if not path or _compatible(path[-1], word, baseline[index - 1], voiced)
                if boundary is None
                or first + index != boundary[0] + 1
                or (path[-1] == boundary[1]) == (word == boundary[2])
            ]
            if paths:
                following.append(min(paths, key=lambda item: item[:2]))
        states = following
    return min(states, key=lambda item: item[:2])[2] if states else original


def _recognition_distance(
    word: ctc.AlignedWord, interval: tuple[float, float] | None, margin: float
) -> float:
    if interval is None:
        return 0.0
    # Word spans can include the previous vowel or silence. Keep the existing
    # recognition margin, but do not let a wide span hide an arbitrarily late onset.
    onset = max(0.0, interval[0] - word.start, round(word.start - interval[0] - margin, 6))
    return onset + max(0.0, interval[0] - word.end, word.end - interval[1])


def _compatible(
    left: ctc.AlignedWord,
    right: ctc.AlignedWord,
    original: ctc.AlignedWord,
    voiced: np.ndarray,
) -> bool:
    return left.start < right.start and ctc._implausible(
        [ctc.ordered([left, right])[0]], voiced
    ) <= ctc._implausible([original], voiced)


def _key(text: str) -> str:
    return "".join(character for character in text.lower() if character.isalnum())


def _matching_blocks(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[ctc.AlignedWord] | None = None,
) -> list[difflib.Match]:
    keys = [_key(word) for word in words]
    heard_keys = [item[0] for item in heard]
    if whole is None:
        return difflib.SequenceMatcher(a=keys, b=heard_keys, autojunk=False).get_matching_blocks()
    # Match coverage first; bounded timing proximity only disambiguates equal-coverage repeats.
    proximity = 1 / (min(len(words), len(heard)) + 1)
    scores = np.zeros((len(words) + 1, len(heard) + 1))
    for i in range(len(words) - 1, -1, -1):
        for j in range(len(heard) - 1, -1, -1):
            match = (
                scores[i + 1, j + 1] + 1 + proximity / (1 + abs(whole[i].start - heard[j][1]))
                if keys[i] == heard_keys[j]
                else 0.0
            )
            scores[i, j] = max(scores[i + 1, j], scores[i, j + 1], match)
    blocks: list[difflib.Match] = []
    i, j = 0, 0
    while i < len(words) and j < len(heard):
        if keys[i] == heard_keys[j] and scores[i, j] == (
            scores[i + 1, j + 1] + 1 + proximity / (1 + abs(whole[i].start - heard[j][1]))
        ):
            if (
                blocks
                and blocks[-1].a + blocks[-1].size == i
                and blocks[-1].b + blocks[-1].size == j
            ):
                previous = blocks[-1]
                blocks[-1] = difflib.Match(previous.a, previous.b, previous.size + 1)
            else:
                blocks.append(difflib.Match(i, j, 1))
            i, j = i + 1, j + 1
        elif scores[i + 1, j] >= scores[i, j + 1]:
            i += 1
        else:
            j += 1
    return blocks
