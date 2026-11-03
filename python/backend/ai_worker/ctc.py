from __future__ import annotations
from collections.abc import Mapping, Sequence
from dataclasses import replace
from math import ceil
from types import MappingProxyType
import numpy as np
import torch
from backend.moment_spreading import spread_tied_moments

from backend.ai_worker.ctc_domain import (
    AlignedWord as AlignedWord,
    Window as Window,
    _CHUNK_SECONDS as _CHUNK_SECONDS,
    _CONTEXT_SECONDS as _CONTEXT_SECONDS,
    _CRAMMED_WORD_SECONDS as _CRAMMED_WORD_SECONDS,
    _HEARD_DISAGREEMENT_SECONDS as _HEARD_DISAGREEMENT_SECONDS,
    _LARGEST_LAG_SECONDS as _LARGEST_LAG_SECONDS,
    _MINIMUM_WORD_SECONDS as _MINIMUM_WORD_SECONDS,
    _ONSET_SEARCH_AFTER_SECONDS as _ONSET_SEARCH_AFTER_SECONDS,
    _ONSET_SEARCH_BEFORE_SECONDS as _ONSET_SEARCH_BEFORE_SECONDS,
    _PAUSE_SECONDS as _PAUSE_SECONDS,
    _PREFERENCE as _PREFERENCE,
    _SILENCE_ENDS_WORD_SECONDS as _SILENCE_ENDS_WORD_SECONDS,
    _SILENT_START_SECONDS as _SILENT_START_SECONDS,
    _VOICE_HOP as _VOICE_HOP,
    _VOICE_RATE as _VOICE_RATE,
)
from backend.ai_worker.ctc_tokens import (
    _COMMON_ROMANIZATION as _COMMON_ROMANIZATION,
    _NON_LETTERS as _NON_LETTERS,
    _character_tokens as _character_tokens,
    _romanizer as _romanizer,
)
from backend.ai_worker.ctc_emission import (
    _model as _model,
    _placed as _placed,
    _transcript_path as _transcript_path,
    align_words as align_words,
    emission as emission,
    frame_stride_samples as frame_stride_samples,
)
from backend.ai_worker.ctc_bounds import (
    _clamped_letters as _clamped_letters,
    _clips_letter_anchor as _clips_letter_anchor,
    _filled_letters as _filled_letters,
    _ordered_letters as _ordered_letters,
    _ordering_diagnostics as _ordering_diagnostics,
    _tied_sounding_letters as _tied_sounding_letters,
    ordered as ordered,
)
from backend.ai_worker.ctc_singing import (
    _first_long_silence as _first_long_silence,
    _sung_continuation as _sung_continuation,
    _sung_end as _sung_end,
    _voice_entries as _voice_entries,
    _voiced_release as _voiced_release,
    with_sung_ends as with_sung_ends,
    with_voice_onsets as with_voice_onsets,
)
from backend.ai_worker.ctc_letters import (
    _bounded_letter_estimate as _bounded_letter_estimate,
    _collapsed_letter_review as _collapsed_letter_review,
    _sung_letter_candidate as _sung_letter_candidate,
    _sung_letter_times as _sung_letter_times,
    _sung_letters_disagree as _sung_letters_disagree,
    _sung_tail_index as _sung_tail_index,
    _sung_tail_supported as _sung_tail_supported,
    with_sung_letters as with_sung_letters,
)


def _align_window(
    scores: torch.Tensor,
    frame_seconds: float,
    chunk: Sequence[str],
    window: Window,
    *,
    recovery_bounds: tuple[float, float] | None = None,
) -> list[AlignedWord]:
    """Retry a failed crop only within caller-supplied neighbouring acoustic anchors."""
    begin = max(0, int(window.start / frame_seconds))
    stop = min(scores.shape[0], max(begin + 1, int(window.end / frame_seconds)))
    attempts = [(begin, stop)]
    if recovery_bounds is not None:
        first, last = recovery_bounds
        expanded = (
            max(0, ceil(max(first, window.start - _CONTEXT_SECONDS) / frame_seconds)),
            min(
                scores.shape[0],
                int(min(last, window.end + _CONTEXT_SECONDS) / frame_seconds),
            ),
        )
        if expanded[0] < expanded[1] and expanded != attempts[0]:
            attempts.append(expanded)
    for begin, stop in attempts:
        try:
            return align_words(scores[begin:stop], frame_seconds, chunk, begin * frame_seconds)
        except ValueError:
            continue
    return _evenly(
        chunk, window.start, max(window.end, window.start + _MINIMUM_WORD_SECONDS * len(chunk))
    )


def _confidence(words: Sequence[AlignedWord]) -> float:
    scored = [word.score for word in words if word.score > 0]
    return float(np.mean(scored)) if scored else 0.0


def align_guided(
    scores: torch.Tensor,
    frame_seconds: float,
    words: Sequence[str],
    windows: Sequence[Window],
    heard: Mapping[int, float] = MappingProxyType({}),
    voiced: np.ndarray | None = None,
    whole: Sequence[AlignedWord] | None = None,
    *,
    anchors: Mapping[int, float] = MappingProxyType({}),
) -> list[AlignedWord]:
    """Choose guided or whole-song timing using recognition and voiced activity."""
    whole = align_words(scores, frame_seconds, words) if whole is None else whole
    result: list[AlignedWord] = []
    for window in windows:
        chunk = list(words[window.first : window.last])
        if not chunk:
            continue
        entry, following = anchors.get(window.first), heard.get(window.last)
        reference = list(whole[window.first : window.last])
        window, entry = _guided_bounds(window, entry, following, reference, voiced)
        recovery_end = _recovery_end(following, whole, window, reference)
        guided = _align_window(
            scores,
            frame_seconds,
            chunk,
            window,
            recovery_bounds=(result[-1].end if result else 0.0, recovery_end),
        )
        candidates = _guided_candidates(
            guided, reference, result, whole, window, following, entry, voiced
        )
        if not candidates:
            return ordered(list(whole))
        result.extend(
            candidates[0]
            if len(candidates) == 1
            else _preferred(guided, reference, window.first, heard, voiced)
        )
    return ordered(result)


def _guided_candidates(
    guided: list[AlignedWord],
    reference: list[AlignedWord],
    result: list[AlignedWord],
    whole: Sequence[AlignedWord],
    window: Window,
    following: float | None,
    entry: float | None,
    voiced: np.ndarray | None,
) -> list[list[AlignedWord]]:
    sequential = [
        candidate
        for candidate in (guided, reference)
        if _follows_word(candidate, result, voiced)
        and (
            window.last == len(whole)
            or following is not None
            # A next word from an earlier repeat cannot veto this phrase
            # before its own window gets a chance to recover it.
            or whole[window.last].start <= reference[-1].start
            or candidate[-1].start < whole[window.last].start
        )
    ]
    candidates = [
        candidate
        for candidate in sequential
        if (
            entry is None
            or window.start - _HEARD_DISAGREEMENT_SECONDS
            <= candidate[0].start
            <= candidate[-1].start
            < window.end
        )
    ] or sequential
    return candidates


def _guided_bounds(
    window: Window,
    entry: float | None,
    following: float | None,
    reference: Sequence[AlignedWord],
    voiced: np.ndarray | None,
) -> tuple[Window, float | None]:
    start = (
        min(window.start, max(0.0, entry - _HEARD_DISAGREEMENT_SECONDS))
        if entry is not None
        else window.start
    )
    window = replace(
        window,
        start=start,
        end=min(window.end, following + _HEARD_DISAGREEMENT_SECONDS)
        if following is not None and following > start
        else window.end,
    )
    if voiced is not None and window.heard_start is not None:
        step = _VOICE_HOP / _VOICE_RATE
        pause = _first_long_silence(voiced, reference[0].start, reference[0].end, step)
        if pause is not None and pause <= window.heard_start:
            first = round(pause / step)
            sounding = np.flatnonzero(voiced[first : round(reference[0].end / step)])
            entry = float((first + sounding[0]) * step) if len(sounding) else pause
            if window.heard_start - _ONSET_SEARCH_BEFORE_SECONDS <= entry < window.end:
                # Refit at returning voice even when coarse recognition trails it.
                window = replace(window, start=max(window.start, entry))
    return window, entry


def _preferred(
    guided: list[AlignedWord],
    reference: list[AlignedWord],
    first: int,
    heard: Mapping[int, float],
    voiced: np.ndarray | None,
) -> list[AlignedWord]:
    # Unchanged words supply no evidence for either placement. Compare the disputed
    # boundaries so one bad word is not hidden by the rest of a correctly timed phrase.
    changed = [
        index
        for index, (left, right) in enumerate(zip(guided, reference, strict=True))
        if max(abs(left.start - right.start), abs(left.end - right.end))
        > _HEARD_DISAGREEMENT_SECONDS
    ]
    local_heard = (
        {first + index: heard[first + index] for index in changed if first + index in heard}
        if changed
        else heard
    )
    guided_miss = _heard_distance(guided, first, local_heard)
    reference_miss = _heard_distance(reference, first, local_heard)
    if (
        guided_miss is not None
        and reference_miss is not None
        and abs(guided_miss - reference_miss) > _HEARD_DISAGREEMENT_SECONDS
    ):
        closer, other = (guided, reference) if guided_miss < reference_miss else (reference, guided)
        if voiced is None or _implausible(closer, voiced) <= _implausible(other, voiced):
            return closer
    left = [guided[index] for index in changed] if changed else guided
    right = [reference[index] for index in changed] if changed else reference
    # Compare relative likelihood: an absolute probability margin suppresses all
    # improvements in weak phonetic cores, even when the guided placement is twice as likely.
    return guided if _confidence(left) > _confidence(right) * (1 + _PREFERENCE) else reference


def _heard_distance(
    words: Sequence[AlignedWord], first: int, heard: Mapping[int, float]
) -> float | None:
    distances = [
        abs(word.start - heard[first + index])
        for index, word in enumerate(words)
        if first + index in heard
    ]
    return float(np.median(distances)) if distances else None


def _implausible(words: Sequence[AlignedWord], voiced: np.ndarray) -> int:
    """Words that start where nothing is sung, or that are crushed too short to be a sung word."""
    step = _VOICE_HOP / _VOICE_RATE
    lead = round(_SILENT_START_SECONDS / step)
    count = 0
    for word in words:
        frame = int(word.start / step)
        if frame < len(voiced) and not voiced[frame : frame + lead].any():
            count += 1
        if (
            word.end - word.start + 1e-9 < _CRAMMED_WORD_SECONDS
            and sum(c.isalnum() for c in word.text) >= 2
        ):
            count += 1
    return count


def _evenly(words: Sequence[str], start: float, end: float) -> list[AlignedWord]:
    weights = np.array([max(len(word), 1) for word in words], dtype=np.float64)
    edges = start + np.concatenate(([0.0], np.cumsum(weights) / weights.sum())) * (end - start)
    result: list[AlignedWord] = []
    for i, word in enumerate(words):
        word_start, word_end = float(edges[i]), float(edges[i + 1])
        count = max(len(word), 1)
        # A window too short for a word's own character count would otherwise round several of its
        # letters to the same displayed millisecond even though this split is nominally even; spreading
        # settles that the same way a same-frame CTC tie is settled elsewhere.
        raw: list[float | None] = [
            word_start + (word_end - word_start) * k / count for k in range(len(word))
        ]
        letters = tuple(
            round(moment, 3) for moment in spread_tied_moments(raw, word_end) if moment is not None
        )
        result.append(
            AlignedWord(
                word, word_start, word_end, letters, diagnostics=("ApproximateLetterTiming",)
            )
        )
    return result


def _recovery_end(
    following: float | None,
    whole: Sequence[AlignedWord],
    window: Window,
    reference: Sequence[AlignedWord],
) -> float:
    recovery_end = (
        following
        if following is not None
        else whole[window.last].start
        if window.last < len(whole)
        else max(window.end, reference[-1].end) + _CONTEXT_SECONDS
    )
    return recovery_end


def _follows_word(
    candidate: Sequence[AlignedWord],
    result: Sequence[AlignedWord],
    voiced: np.ndarray | None,
) -> bool:
    return (
        (not result or candidate[0].start > result[-1].start + 1e-9)
        # A separate crop can reuse the preceding word's suffix. Its higher
        # mean score cannot erase supported anchors, but weak forced paths may be replaced.
        and (
            not result
            or result[-1].score <= _PREFERENCE
            or not _clips_letter_anchor(result[-1], candidate[0].start)
        )
        and (
            not result
            or voiced is None
            or _implausible([ordered([result[-1], candidate[0]])[0]], voiced)
            <= _implausible([result[-1]], voiced)
        )
    )
