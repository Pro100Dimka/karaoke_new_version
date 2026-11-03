from __future__ import annotations
from collections.abc import Mapping
from dataclasses import replace
import numpy as np
import torch

from backend.ai_worker.ctc_domain import (
    AlignedWord as AlignedWord,
    _HEARD_DISAGREEMENT_SECONDS as _HEARD_DISAGREEMENT_SECONDS,
    _PREFERENCE as _PREFERENCE,
    _SILENCE_ENDS_WORD_SECONDS as _SILENCE_ENDS_WORD_SECONDS,
    _VOICE_HOP as _VOICE_HOP,
    _VOICE_RATE as _VOICE_RATE,
)
from backend.ai_worker.ctc_tokens import (
    _character_tokens as _character_tokens,
)
from backend.ai_worker.ctc_emission import (
    align_words as align_words,
)
from backend.ai_worker.ctc_bounds import (
    _clamped_letters as _clamped_letters,
)


def with_sung_letters(
    words: list[AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    activity: np.ndarray,
    heard: Mapping[int, tuple[float, float]],
) -> list[AlignedWord]:
    """Recheck sung suffixes inside confirmed bounds; preserve word times and supported letters."""
    result = list(words)
    for index, word in enumerate(words):
        if (review := _collapsed_letter_review(word, scores, frame_seconds, activity)) is not None:
            result[index] = review
            continue
        following = words[index + 1] if index + 1 < len(words) else None
        last = _sung_tail_index(word)
        if last is None or not _sung_tail_supported(
            word, last, following, heard.get(index), activity, frame_seconds
        ):
            continue
        begin, end = max(0, int(word.start / frame_seconds)), round(word.end / frame_seconds)
        crop = scores[begin:end]
        try:
            original = align_words(crop, frame_seconds, [word.text], begin * frame_seconds)[0]
            candidate = align_words(
                crop, frame_seconds, [word.text], begin * frame_seconds, bounded_end=True
            )[0]
        except ValueError:
            result[index] = replace(
                word, diagnostics=(*word.diagnostics, "SungLetterAlignmentUnresolved")
            )
            continue
        letters = _sung_letter_candidate(word, original, candidate, last, scores, frame_seconds)
        if letters is not None:
            result[index] = replace(
                word, letters=letters, diagnostics=(*word.diagnostics, "SungConsonantRetimed")
            )
        elif _sung_letters_disagree(word, original, candidate, frame_seconds):
            flags = (*word.diagnostics, "LetterTimingReviewRequired", "ApproximateLetterTiming")
            result[index] = replace(word, diagnostics=tuple(dict.fromkeys(flags)))
    return result


def _collapsed_letter_review(
    word: AlignedWord, scores: torch.Tensor, step: float, activity: np.ndarray
) -> AlignedWord | None:
    """A clipped phonetic suffix is approximate even when a bounded CTC estimate is available."""
    first = next(
        (
            i
            for i, (char, moment) in enumerate(zip(word.text, word.letters))
            if char.isalnum() and char.casefold() not in "ьъ" and moment >= word.end
        ),
        None,
    )
    if first is None:
        return None
    flags = (*word.diagnostics, "LetterTimingReviewRequired", "ApproximateLetterTiming")
    word = replace(word, diagnostics=tuple(dict.fromkeys(flags)))
    voice_step = _VOICE_HOP / _VOICE_RATE
    stop = round(word.end / voice_step)
    needed = round(_SILENCE_ENDS_WORD_SECONDS / voice_step)
    pause = activity[stop : stop + needed]
    # A conflicting neighbour is not an acoustic endpoint. Keep it unresolved;
    # this path only estimates letters inside a word stopped by a real pause.
    if (
        first == 0
        or word.score <= 0
        or len(word.letters) != len(word.text)
        or len(pause) != needed
        or pause.any()
    ):
        return word
    return _bounded_letter_estimate(word, scores, step, first)


def _bounded_letter_estimate(
    word: AlignedWord, scores: torch.Tensor, step: float, first: int
) -> AlignedWord:
    """Keep intact anchors and word bounds; the replacement suffix remains approximate."""
    begin, stop = max(0, int(word.start / step)), round(word.end / step)
    try:
        candidate = align_words(
            scores[begin:stop], step, [word.text], begin * step, bounded_end=True
        )[0]
    except ValueError:
        return word
    shift = word.letters[0] - candidate.letters[0]
    if candidate.score <= 0 or any(
        abs(saved - (moment + shift)) > step + 1e-9
        for saved, moment in zip(word.letters[:first], candidate.letters[:first], strict=True)
    ):
        return word
    letters = (
        *word.letters[:first],
        *(round(moment + shift, 3) for moment in candidate.letters[first:]),
    )
    if (
        letters[0] < word.start
        or letters[-1] > word.end
        or any(a > b for a, b in zip(letters, letters[1:]))
        or any(
            char.isalnum() and char.casefold() not in "ьъ" and start >= end
            for char, start, end in zip(
                word.text[first:], letters[first:], (*letters[first + 1 :], word.end), strict=True
            )
        )
    ):
        return word
    return replace(word, letters=letters, score=min(word.score, candidate.score))


def _sung_letters_disagree(
    word: AlignedWord, original: AlignedWord, candidate: AlignedWord, step: float
) -> bool:
    if not max(original.score, candidate.score) >= word.score:
        return False
    shift = word.letters[0] - original.letters[0]
    return any(
        char.isalpha() and char.casefold() not in "ьъ" and abs(moment + shift - saved) > step + 1e-9
        for aligned in (original, candidate)
        for char, moment, saved in zip(word.text, aligned.letters, word.letters, strict=True)
    )


def _sung_tail_index(word: AlignedWord) -> int | None:
    if word.score <= 0 or len(word.letters) != len(word.text):
        return None
    pronounced = [
        i for i, char in enumerate(word.text) if char.isalpha() and char.casefold() not in "ьъ"
    ]
    last = pronounced[-1] if pronounced else -1
    if (
        last < 1
        or word.text[last].casefold() in "aeiouyаеёиоуыэюяіїє"
        or word.end - word.letters[last] <= _HEARD_DISAGREEMENT_SECONDS
    ):
        return None
    return last


def _sung_tail_supported(
    word: AlignedWord,
    last: int,
    following: AlignedWord | None,
    heard: tuple[float, float] | None,
    activity: np.ndarray,
    step: float,
) -> bool:
    bounded = (
        heard is not None
        and heard[0] - _HEARD_DISAGREEMENT_SECONDS <= word.start < heard[1]
        and abs(heard[1] - word.end) <= _HEARD_DISAGREEMENT_SECONDS
    ) or (
        following is not None
        and following.score > _PREFERENCE
        and "BoundaryConflict" not in following.diagnostics
        and abs(following.start - word.end) <= step
    )
    voice_step = _VOICE_HOP / _VOICE_RATE
    first, stop = int(word.letters[last] / voice_step), round(word.end / voice_step)
    return bounded and 0 <= first < stop <= len(activity) and bool(activity[first:stop].all())


def _sung_letter_candidate(
    word: AlignedWord,
    original: AlignedWord,
    candidate: AlignedWord,
    last: int,
    scores: torch.Tensor,
    step: float,
) -> tuple[float, ...] | None:
    shift = word.letters[0] - original.letters[0]
    if candidate.score < max(word.score, original.score) or any(
        abs(a - b) > step
        for a, b in zip(candidate.letters[:last], original.letters[:last], strict=True)
    ):
        return None
    characters = _character_tokens(word.text)
    tokens = characters[last]
    if not tokens:
        return None
    previous = original.letters[last]
    if (
        len(tokens) == 1
        and abs(previous - candidate.letters[last]) <= step
        and abs(previous + shift - word.letters[last]) > step + 1e-9
    ):
        previous = word.letters[last] - shift
    if not 0 <= round(previous / step) < len(scores):
        return None
    support = [
        float(scores[round(moment / step), tokens[0]].exp())
        for moment in (previous, candidate.letters[last])
    ]
    if support[1] <= support[0] + _PREFERENCE:
        return None
    return _sung_letter_times(word, candidate, last, characters, scores, step, shift)


def _sung_letter_times(
    word: AlignedWord,
    candidate: AlignedWord,
    last: int,
    characters: list[list[int]],
    scores: torch.Tensor,
    step: float,
    shift: float,
) -> tuple[float, ...] | None:
    prefix = list(word.letters[:last])
    for index, saved in enumerate(prefix):
        proposed = candidate.letters[index] + shift
        if abs(proposed - saved) <= step + 1e-9:
            continue
        # A romanized multi-token grapheme has no single posterior that can
        # certify its whole movement. Keep it pending rather than guess a split.
        if len(characters[index]) != 1:
            return None
        before, after = round((saved - shift) / step), round(candidate.letters[index] / step)
        if not 0 <= before < len(scores):
            return None
        token = characters[index][0]
        if float(scores[after, token].exp()) <= float(scores[before, token].exp()) + _PREFERENCE:
            return None
        prefix[index] = round(proposed, 3)
    tail = _clamped_letters(
        candidate.letters[last:], shift, prefix[-1], word.end, text=word.text[last:]
    )
    if tail[0] <= word.letters[last] + step or tail[0] >= word.end:
        return None
    result = (*prefix, *tail)
    if (
        result[0] < word.start
        or result[-1] > word.end
        or any(a > b for a, b in zip(result, result[1:]))
    ):
        return None
    return result
