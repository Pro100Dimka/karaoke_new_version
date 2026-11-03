from __future__ import annotations
from collections.abc import Mapping, Sequence
from dataclasses import replace
import numpy as np
import torch
from backend.ai_worker import ctc

from backend.ai_worker.guidance_candidates import (
    _crosses_confirmed_entry as _crosses_confirmed_entry,
    _silent_prefix_entry as _silent_prefix_entry,
    _stable_following_words as _stable_following_words,
)
from backend.ai_worker.guidance_windows import (
    _review_windows as _review_windows,
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
