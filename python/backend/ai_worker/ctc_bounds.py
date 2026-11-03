from __future__ import annotations
from collections.abc import Sequence
from dataclasses import replace
from backend.moment_spreading import is_tied_with, spread_tied_moments

from backend.ai_worker.ctc_domain import (
    AlignedWord as AlignedWord,
    _CRAMMED_WORD_SECONDS as _CRAMMED_WORD_SECONDS,
    _HEARD_DISAGREEMENT_SECONDS as _HEARD_DISAGREEMENT_SECONDS,
    _VOICE_HOP as _VOICE_HOP,
    _VOICE_RATE as _VOICE_RATE,
)


def _clamped_letters(
    letters: Sequence[float], shift: float, start: float, end: float, *, text: str = ""
) -> tuple[float, ...]:
    """Shifts every letter by ``shift`` and clamps it to ``[start, end]``, then spreads away any run a
    shared boundary collapsed onto the same instant. Clamping each letter independently, without this,
    would leave a whole run of a word's opening letters flashing by together (see spread_tied_moments).
    """
    # Filled silent characters share the next sound's anchor; they are not extra
    # phonetic events and must not push that sound later when ties are spread.
    clamped: list[float | None] = [
        None
        if index < len(text) and (not text[index].isalnum() or text[index].casefold() in "ьъ")
        else min(max(moment + shift, start), end)
        for index, moment in enumerate(letters)
    ]
    return _filled_letters(spread_tied_moments(clamped, end), end)


def _filled_letters(letters: list[float | None], end: float) -> tuple[float, ...]:
    """A character without its own sound (ь, a comma) starts together with the next one."""
    filled = [
        moment
        if moment is not None
        else next((later for later in letters[index + 1 :] if later is not None), end)
        for index, moment in enumerate(letters)
    ]
    return tuple(round(moment, 3) for moment in filled)


def _tied_sounding_letters(text: str, letters: Sequence[float]) -> bool:
    sounding = [
        moment
        for char, moment in zip(text, letters)
        if char.isalnum() and char.casefold() not in "ьъ"
    ]
    return any(left == right for left, right in zip(sounding, sounding[1:]))


def _ordered_letters(word: AlignedWord, start: float, end: float) -> tuple[float, ...]:
    # Preserve bounded anchors after rounding; repeat spreading only after a new
    # clamp, or for unresolved sounding ties that have not yet been estimated.
    if any(moment < start or moment > end for moment in word.letters) or (
        "ApproximateLetterTiming" not in word.diagnostics
        and _tied_sounding_letters(word.text, word.letters)
    ):
        return _clamped_letters(word.letters, 0.0, start, end, text=word.text)
    return tuple(round(moment, 3) for moment in word.letters)


def ordered(words: list[AlignedWord]) -> list[AlignedWord]:
    """Settle overlaps without letting unsupported starts clip cores or propagate into later words."""
    starts: list[float] = []
    cursor = 0.0
    for word in words:
        start = max(round(word.start, 3), cursor)
        starts.append(start)
        # Reserve only one serialized millisecond; real fast words need no 50-ms speech minimum.
        cursor = round(start + 0.001, 3)
    for index in range(1, len(words)):
        previous, word = words[index - 1 : index + 1]
        end = round(previous.end, 3)
        limit = min(round(word.end, 3), starts[index + 1] if index + 1 < len(words) else word.end)
        # A proportional fallback has no acoustic start to justify cutting its
        # supported neighbour. Use only its own available span; never push the
        # conflict into a later word. Competing supported cores still need review.
        if previous.score > 0 and word.score <= 0 and starts[index] < end < limit:
            starts[index] = end
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        start = starts[index]
        end = max(round(word.end, 3), round(start + 0.001, 3))
        if index + 1 < len(starts):
            end = min(end, starts[index + 1])
        letters = _ordered_letters(word, start, end)
        result.append(
            replace(
                word,
                start=round(start, 3),
                end=round(end, 3),
                letters=letters,
                diagnostics=_ordering_diagnostics(word, start, end, letters),
            )
        )
    return result


def _clips_letter_anchor(word: AlignedWord, end: float) -> bool:
    """A sounding anchor on the new end loses its positive interval too."""
    return any(
        end - 1e-9 <= moment < word.end - 1e-9
        for char, moment in zip(word.text, word.letters)
        if char.isalnum() and char.casefold() not in "ьъ"
    )


def _ordering_diagnostics(
    word: AlignedWord, start: float, end: float, letters: tuple[float, ...]
) -> tuple[str, ...]:
    clipped = word.end - end > _VOICE_HOP / _VOICE_RATE + 1e-9
    conflict = (
        start > word.start + 0.001
        or word.end - end > _HEARD_DISAGREEMENT_SECONDS
        or clipped
        and (end - start <= (word.end - word.start) / 2 + 1e-9 or _clips_letter_anchor(word, end))
        or word.end - word.start >= _CRAMMED_WORD_SECONDS
        and end - start + 1e-9 < _CRAMMED_WORD_SECONDS
    )
    return tuple(
        dict.fromkeys(
            (
                *word.diagnostics,
                *(("BoundaryClipped",) if clipped else ()),
                *(("BoundaryConflict",) if conflict else ()),
                *(
                    ("ApproximateLetterTiming", "LetterTimingReviewRequired")
                    if letters != tuple(round(moment, 3) for moment in word.letters)
                    or _tied_sounding_letters(word.text, letters)
                    else ()
                ),
            )
        )
    )


def _preserved_onset_letters(
    before: AlignedWord, core: AlignedWord, started: AlignedWord, adjusted: AlignedWord
) -> AlignedWord:
    """A cropped opening does not measure a new lag for unchanged interior CTC anchors."""
    if "OnsetRecovered" not in core.diagnostics or before.end != core.end:
        return adjusted
    if len({len(word.letters) for word in (before, core, started, adjusted)}) != 1:
        return adjusted
    letters = list(adjusted.letters)
    for index in range(1, len(letters)):
        if (
            before.letters[index] == core.letters[index]
            and adjusted.start < started.letters[index] < adjusted.end
        ):
            letters[index] = started.letters[index]
    if tuple(letters) == adjusted.letters:
        return adjusted
    flags = tuple(
        dict.fromkeys(
            (*adjusted.diagnostics, "ApproximateLetterTiming", "LetterTimingReviewRequired")
        )
    )
    if not _compatible_letter_anchors(letters, started.letters, adjusted.letters):
        return replace(adjusted, diagnostics=flags)
    return replace(adjusted, letters=tuple(letters), diagnostics=flags)


def _compatible_letter_anchors(
    letters: Sequence[float], previous: Sequence[float], candidate: Sequence[float]
) -> bool:
    """Keep existing silent-character ties, but never create a crossing or a new tied run."""
    for index, (first, second) in enumerate(zip(letters, letters[1:])):
        if first > second:
            return False
        if (
            is_tied_with(second, first)
            and not is_tied_with(previous[index + 1], previous[index])
            and not is_tied_with(candidate[index + 1], candidate[index])
        ):
            return False
    return True
