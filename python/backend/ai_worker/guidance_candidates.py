from __future__ import annotations
from collections.abc import Mapping, Sequence
from dataclasses import replace
import numpy as np
import torch
from backend.ai_worker import ctc

from backend.ai_worker.guidance_windows import _REVIEW_MAX_SECONDS


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
