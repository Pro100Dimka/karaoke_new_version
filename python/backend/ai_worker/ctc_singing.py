from __future__ import annotations
from collections.abc import Sequence
from dataclasses import replace
import numpy as np
from backend.ai_worker.timing import (
    _BRIDGED_GAP_SECONDS,
    _bridged,
    _runs,
    audible_frames,
    continued_frames,
    harmonic_evidence,
    singing_frames,
    vocal_onsets,
    voiced_frames,
)

from backend.ai_worker.ctc_domain import (
    AlignedWord as AlignedWord,
    _LARGEST_LAG_SECONDS as _LARGEST_LAG_SECONDS,
    _ONSET_SEARCH_AFTER_SECONDS as _ONSET_SEARCH_AFTER_SECONDS,
    _ONSET_SEARCH_BEFORE_SECONDS as _ONSET_SEARCH_BEFORE_SECONDS,
    _PAUSE_SECONDS as _PAUSE_SECONDS,
    _SILENCE_ENDS_WORD_SECONDS as _SILENCE_ENDS_WORD_SECONDS,
    _SILENT_START_SECONDS as _SILENT_START_SECONDS,
    _VOICE_HOP as _VOICE_HOP,
    _VOICE_RATE as _VOICE_RATE,
)
from backend.ai_worker.ctc_bounds import (
    _clamped_letters as _clamped_letters,
)


def with_sung_ends(
    words: list[AlignedWord],
    samples: np.ndarray,
    instrumental: np.ndarray | None = None,
    voiced: np.ndarray | None = None,
    harmonics: tuple[np.ndarray, np.ndarray] | None = None,
    audible: np.ndarray | None = None,
    periodicity: np.ndarray | None = None,
) -> list[AlignedWord]:
    """Extend phonetic cores through singing, stopping at silence or the next word."""
    if voiced is None:
        voiced = singing_frames(samples, instrumental, _VOICE_RATE, _VOICE_HOP)
    if harmonics is None and instrumental is not None:
        harmonics = harmonic_evidence(samples, _VOICE_RATE, _VOICE_HOP)
    if periodicity is None:
        periodicity = (harmonics or harmonic_evidence(samples, _VOICE_RATE, _VOICE_HOP))[1]
    step = _VOICE_HOP / _VOICE_RATE
    continuation = _sung_continuation(samples, voiced, audible, periodicity)
    periodic = _bridged(periodicity >= 0.5, round(_BRIDGED_GAP_SECONDS / step))
    result: list[AlignedWord] = []
    for index, word in enumerate(words):
        limit = words[index + 1].start if index + 1 < len(words) else len(voiced) * step
        continued = continued_frames(voiced, harmonics, (word.start, word.end, limit), step)
        end = _sung_end(word, continued, continuation, periodicity, periodic, limit)
        silence = _first_long_silence(continued, word.start, end, step)
        letters = word.letters
        if silence is not None:
            end = max(silence, word.start + 0.001)
            letters = _clamped_letters(word.letters, 0.0, word.start, end, text=word.text)
        flags = dict.fromkeys(word.diagnostics)
        if letters != word.letters:
            flags.update(ApproximateLetterTiming=None, LetterTimingReviewRequired=None)
        end = round(max(end, word.start + 0.001), 3)
        result.append(replace(word, end=end, letters=letters, diagnostics=tuple(flags)))
    return result


def _sung_continuation(
    samples: np.ndarray, voiced: np.ndarray, audible: np.ndarray | None, periodicity: np.ndarray
) -> np.ndarray:
    # Phrase activity bridges consonant closures. After a confirmed phonetic core,
    # a real release must not bridge into a later breath, echo, or new entry.
    continuation = _bridged(
        audible_frames(samples, _VOICE_HOP) if audible is None else audible,
        round(_SILENT_START_SECONDS * _VOICE_RATE / _VOICE_HOP) - 1,
    )
    for first, last in _runs(continuation, False):
        if not (
            0 < first < last < len(continuation)
            and voiced[first:last].all()
            and float(np.median(periodicity[first:last])) >= 0.5
        ):
            continue
        # A quiet vowel can survive the loudness threshold. Short windows follow
        # melismas, strictly inside the dip so adjacent sounds cannot fill silence.
        gap = samples[first * _VOICE_HOP : last * _VOICE_HOP]
        frames = np.lib.stride_tricks.sliding_window_view(gap, 4 * _VOICE_HOP)[::_VOICE_HOP]
        spectrum = np.fft.rfft(frames - frames.mean(axis=1, keepdims=True), n=8 * _VOICE_HOP)
        correlation = np.fft.irfft(np.abs(spectrum) ** 2, n=8 * _VOICE_HOP)
        support = correlation[:, round(_VOICE_RATE / 1100) : round(_VOICE_RATE / 65)].max(axis=1)
        support /= np.maximum(correlation[:, 0], 1e-12)
        if float(np.median(support)) >= 0.5:
            continuation[first:last] = True
    return continuation


def _voiced_release(word: AlignedWord, periodicity: np.ndarray, step: float) -> bool:
    ending = next((char.casefold() for char in reversed(word.text) if char.isalpha()), "")
    core = periodicity[
        round(max(word.start, word.end - _SILENT_START_SECONDS) / step) : round(word.end / step)
    ]
    return (
        bool(ending)
        and ending in "aeiouyаеёиоуыэюяіїєймнлрmnrl"
        and len(core) >= round(_SILENT_START_SECONDS / step)
        and bool((core >= 0.5).all())
    )


def _sung_end(
    word: AlignedWord,
    continued: np.ndarray,
    continuation: np.ndarray,
    periodicity: np.ndarray,
    periodic: np.ndarray,
    limit: float,
) -> float:
    step = _VOICE_HOP / _VOICE_RATE
    last_letter = max(
        (
            moment
            for char, moment in zip(word.text, word.letters)
            if char.isalnum() and char.casefold() not in "ьъ"
        ),
        default=word.start,
    )
    # Onset calibration may shift a letter into the preceding vowel. Only
    # the ending sound can establish release; preserve quiet final fricatives
    # and stop closures whose earlier vowel would bias a whole-letter median.
    terminal = max(last_letter, word.end - _SILENT_START_SECONDS)
    core = periodicity[round(terminal / step) : round(word.end / step)]
    periodic_core = bool(len(core)) and float(np.median(core)) >= 0.5
    # A periodic vowel or sonorant can release straight into a breath without
    # an amplitude gap. Phrase activity alone cannot authorize that new noise.
    # Keep brief pitch dropouts, and never shorten the confirmed phonetic core.
    voiced_ending = periodic_core and _voiced_release(word, periodicity, step)
    frame = min(int(word.end / step), len(continued) - 1)
    while (
        frame + 1 < min(len(continued), len(continuation))
        and continued[frame]
        and (not periodic_core or continuation[frame])
        and (not voiced_ending or periodic[frame])
        and frame * step < limit
    ):
        frame += 1
    return max(word.end, min(frame * step, limit))


def _first_long_silence(voiced: np.ndarray, start: float, end: float, step: float) -> float | None:
    """Where the first pause of at least _SILENCE_ENDS_WORD_SECONDS after the word's sound begins starts."""
    first, last = int(start / step), min(len(voiced), int(end / step))
    sounding = np.flatnonzero(voiced[first:last])
    if not len(sounding):
        return None
    needed = round(_SILENCE_ENDS_WORD_SECONDS / step)
    run = 0
    for frame in range(first + int(sounding[0]), last):
        run = 0 if voiced[frame] else run + 1
        if run >= needed:
            return (frame - run + 1) * step
    return None


def with_voice_onsets(
    words: list[AlignedWord], samples: np.ndarray, voiced: np.ndarray | None = None
) -> list[AlignedWord]:
    """Calibrate from measured voice entries; keep uncalibrated starts explicitly uncertain."""
    if voiced is None:
        voiced = voiced_frames(samples, _VOICE_RATE, _VOICE_HOP)
    step = _VOICE_HOP / _VOICE_RATE
    found = _voice_entries(words, voiced, step)
    if not found and len(samples):
        found = _voice_entries(words, voiced, step, vocal_onsets(samples, _VOICE_RATE, _VOICE_HOP))
    lags = [words[index].start - onset for index, onset in found.items()]
    lag = min(_LARGEST_LAG_SECONDS, max(0.0, float(np.median(lags)))) if lags else 0.0
    result: list[AlignedWord] = []
    floor = 0.0
    for index, word in enumerate(words):
        if index in found:
            lag = min(_LARGEST_LAG_SECONDS, max(0.0, word.start - found[index]))
        # A locally recovered entry supplies its own anchor. Calibrate it only from
        # a nearby acoustic entry, never from the unrelated first word's lag.
        start = (
            word.start
            if "OnsetRecovered" in word.diagnostics and index not in found
            else found.get(index, word.start - lag)
        )
        start = max(min(start, word.end - 0.001), floor)
        shift = start - word.start
        end = max(word.end, start + 0.001)
        letters = _clamped_letters(word.letters, shift, start, end, text=word.text)
        diagnostics = word.diagnostics
        if not found and "OnsetRecovered" not in diagnostics:
            diagnostics = tuple(dict.fromkeys((*diagnostics, "OnsetReviewRequired")))
        result.append(
            replace(word, start=round(start, 3), end=end, letters=letters, diagnostics=diagnostics)
        )
        floor = start
    return result


def _voice_entries(
    words: Sequence[AlignedWord], voiced: np.ndarray, step: float, onsets: np.ndarray | None = None
) -> dict[int, float]:
    """Find local voice entries without dropping quieter recognized initial consonants."""
    if onsets is None:
        onsets = (np.flatnonzero(voiced[1:] & ~voiced[:-1]) + 1) * step
    found: dict[int, float] = {}
    for index, word in enumerate(words):
        after_pause = index == 0 or word.start - words[index - 1].end >= _PAUSE_SECONDS
        nearby = onsets[
            (onsets >= word.start - _ONSET_SEARCH_BEFORE_SECONDS)
            & (onsets <= word.start + _ONSET_SEARCH_AFTER_SECONDS)
        ]
        if not after_pause:
            # The acoustic pause can be clear even when the preceding CTC core ends late.
            nearby = nearby[nearby >= words[index - 1].end]
        if len(nearby):
            onset = float(nearby[np.argmin(np.abs(nearby - word.start))])
            # A quiet initial consonant can precede the louder vowel or nasal entry.
            found[index] = min(word.start, onset)
    return found
