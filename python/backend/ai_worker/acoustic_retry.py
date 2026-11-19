from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from math import ceil, floor, isfinite
from statistics import median

import numpy as np
import torch

from backend.ai_worker import ctc
from backend.ai_worker.recognition import HeardWord, heard_timings
from backend.ai_worker.speech_windows import _MARGIN_SECONDS, _MINIMUM_BLOCK, _SAMPLE_RATE

Emission = Callable[[np.ndarray], tuple[torch.Tensor, float]]
Interval = tuple[float, float]


@dataclass(frozen=True, slots=True)
class _Retry:
    first: int
    last: int
    start: int
    stop: int
    audio_start: int
    audio_stop: int


def recover_emission(
    audio: np.ndarray,
    scores: torch.Tensor,
    step: float,
    lyrics: str,
    views: Sequence[list[HeardWord]],
    emit: Emission,
) -> torch.Tensor:
    """Repair late CTC cores using corroborated native views and acoustic neighbours.

    The caller supplies distinct full recordings, never reconstructed ASR prefixes.
    New scores can replace only the bounded core, with every outside word unchanged.
    """
    words = lyrics.split()
    if not _valid_input(audio, scores, step, words, views):
        return scores
    try:
        whole = ctc.align_words(scores, step, words)
    except ValueError:
        return scores
    agreed = _agreed_intervals(words, views, whole)
    result = scores
    for window in _retry_windows(whole, scores, step, lyrics, agreed, len(audio)):
        updated = _retry(audio, result, step, words, whole, agreed, window, emit)
        if updated is not None:
            result, whole = updated
    return result


def _valid_input(
    audio: np.ndarray,
    scores: torch.Tensor,
    step: float,
    words: list[str],
    views: Sequence[list[HeardWord]],
) -> bool:
    return (
        bool(words)
        and audio.ndim == 1
        and len(audio) > 0
        and scores.ndim == 2
        and len(scores) > 0
        and len(views) >= 2
        and isfinite(step)
        and step > 0
        and abs(step * _SAMPLE_RATE - ctc.frame_stride_samples()) < 1e-8
    )


def _agreed_intervals(
    words: list[str], views: Sequence[list[HeardWord]], whole: Sequence[ctc.AlignedWord]
) -> dict[int, Interval]:
    matches = [heard_timings(words, view, whole, minimum_block=_MINIMUM_BLOCK) for view in views]
    agreed = {}
    for index in set().union(*(match.keys() for match in matches)):
        spans = [match[index] for match in matches if index in match]
        spans = [(a, b) for a, b in spans if isfinite(a) and isfinite(b) and 0 <= a < b]
        if (
            len(spans) >= 2
            and max(a for a, _ in spans) - min(a for a, _ in spans) <= _MARGIN_SECONDS
            and max(a for a, _ in spans) < min(b for _, b in spans)
        ):
            agreed[index] = float(median(a for a, _ in spans)), max(b for _, b in spans)
    return agreed


def _stable(word: ctc.AlignedWord, interval: Interval | None) -> bool:
    return (
        interval is not None
        and word.score > ctc._PREFERENCE
        and abs(word.start - interval[0]) <= _MARGIN_SECONDS
        and word.end <= interval[1] + _MARGIN_SECONDS
    )


def _displaced(word: ctc.AlignedWord, interval: Interval) -> bool:
    # A late confident core can borrow the next word's phonemes and block its
    # own earlier occurrence. Earlier drift remains on the existing guidance path.
    return word.start > interval[1] + ctc._HEARD_DISAGREEMENT_SECONDS


def _unsupported_core(
    word: ctc.AlignedWord, scores: torch.Tensor, step: float, interval: Interval, lyrics: str
) -> bool:
    start, stop = max(0, floor(interval[0] / step)), min(len(scores), ceil(interval[1] / step))
    tokens = [token for letters in ctc._character_tokens(word.text, lyrics) for token in letters]
    if start >= stop or not tokens or max(tokens) >= scores.shape[1]:
        return False
    # This is an upper bound on every possible word path, not a new acceptance threshold.
    upper = torch.stack([scores[start:stop, token].max().exp() for token in tokens]).mean()
    return float(upper) <= ctc._PREFERENCE


def _retry_windows(
    words: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    step: float,
    lyrics: str,
    agreed: Mapping[int, Interval],
    samples: int,
) -> list[_Retry]:
    stable = [index for index, word in enumerate(words) if _stable(word, agreed.get(index))]
    bounds = set()
    for index, interval in sorted(agreed.items()):
        if not _displaced(words[index], interval) or not _unsupported_core(
            words[index], scores, step, interval, lyrics
        ):
            continue
        left = max((anchor for anchor in stable if anchor < index), default=None)
        right = min((anchor for anchor in stable if anchor > index), default=None)
        if left is not None and right is not None:
            bounds.add((left, right))
    return [
        window
        for left, right in sorted(bounds)
        if (window := _bounded_window(left, right, words, step, samples)) is not None
    ]


def _bounded_window(
    left: int, right: int, words: Sequence[ctc.AlignedWord], step: float, samples: int
) -> _Retry | None:
    start = ceil(words[left].end / step - 1e-9)
    stop = floor(words[right].start / step + 1e-9)
    first = max(0, floor((words[left].end - ctc._CONTEXT_SECONDS) / step + 1e-9))
    last = min(
        ceil(samples / (step * _SAMPLE_RATE)),
        ceil((words[right].start + ctc._CONTEXT_SECONDS) / step - 1e-9),
    )
    if start >= stop or (last - first) * step > ctc._CHUNK_SECONDS:
        return None
    return _Retry(left + 1, right, start, stop, first, last)


def _retry(
    audio: np.ndarray,
    scores: torch.Tensor,
    step: float,
    words: list[str],
    whole: Sequence[ctc.AlignedWord],
    agreed: Mapping[int, Interval],
    window: _Retry,
    emit: Emission,
) -> tuple[torch.Tensor, list[ctc.AlignedWord]] | None:
    stride = ctc.frame_stride_samples()
    local, local_step = emit(audio[window.audio_start * stride : window.audio_stop * stride])
    first, last = window.start - window.audio_start, window.stop - window.audio_start
    if not _valid_local(local, local_step, scores, step, first, last):
        return None
    try:
        candidates = ctc.align_words(
            local[first:last],
            step,
            words[window.first : window.last],
            window.start * step,
            bounded_end=True,
        )
    except ValueError:
        return None
    if not _supported(candidates, whole, agreed, window):
        return None
    changed = scores.clone()
    changed[window.start : window.stop] = local[first:last]
    try:
        timed = ctc.align_words(changed, step, words)
    except ValueError:
        return None
    if any(
        old != new
        for index, (old, new) in enumerate(zip(whole, timed, strict=True))
        if not window.first <= index < window.last
    ):
        return None
    return changed, timed


def _valid_local(
    local: torch.Tensor,
    local_step: float,
    scores: torch.Tensor,
    step: float,
    first: int,
    last: int,
) -> bool:
    return (
        local_step == step
        and local.ndim == 2
        and local.shape[1] == scores.shape[1]
        and local.dtype == scores.dtype
        and local.device == scores.device
        and 0 <= first < last <= len(local)
        and bool(torch.isfinite(local[first:last]).all())
    )


def _supported(
    candidates: Sequence[ctc.AlignedWord],
    whole: Sequence[ctc.AlignedWord],
    agreed: Mapping[int, Interval],
    window: _Retry,
) -> bool:
    if len(candidates) != window.last - window.first:
        return False
    for index, candidate in enumerate(candidates, window.first):
        if (
            candidate.score <= ctc._PREFERENCE
            or candidate.score + ctc._PREFERENCE < whole[index].score
        ):
            return False
        if (interval := agreed.get(index)) is not None and not (
            interval[0] - _MARGIN_SECONDS <= candidate.start < interval[1]
            and candidate.end <= interval[1] + _MARGIN_SECONDS
        ):
            return False
    return any(
        _displaced(whole[index], interval)
        and not _displaced(candidates[index - window.first], interval)
        for index, interval in agreed.items()
        if window.first <= index < window.last
    )
