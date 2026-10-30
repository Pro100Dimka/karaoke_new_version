from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from collections import Counter
from dataclasses import replace
import threading
from pathlib import Path

import numpy as np
from faster_whisper.transcribe import Segment
from whisper.audio import CHUNK_LENGTH

from backend.ai_worker.ctc import AlignedWord, Window, _PREFERENCE
from backend.ai.domain import WordTiming
from backend.processing.reporting import rate_reviews
from backend.ai_worker.timing import _runs
from backend.ai_worker.word_guidance import _key, _matching_blocks, phrase_window, recognized_phrase
from backend.lyrics.phrases import _lyrics_key, performed_phrases

_MARGIN = 0.6
_STEP = 0.01
HeardWord = tuple[str, float, float]


def rate_review_indices(words: Sequence[AlignedWord], lyrics: str) -> set[int]:
    reviews = rate_reviews(
        [WordTiming(w.text, w.start, w.end, w.score, tuple(w.letters)) for w in words], lyrics
    )
    return {index for first, last in reviews for index in range(first, last)}


def independent_words(
    vocal: Path,
    samples: np.ndarray,
    instrumental: np.ndarray | None,
    recognition: Mapping[str, object] | None,
    recognize: Callable[[Path | np.ndarray], Mapping[str, object]],
) -> list[list[tuple[str, float, float]]]:
    """Reuse the job's verified independent views before reconstructing another full mix."""
    candidates = [heard_words(recognition if recognition is not None else recognize(vocal))]
    alternatives = recognition.get("alternatives", []) if recognition is not None else []
    if isinstance(alternatives, list):
        candidates.extend(
            words
            for view in alternatives
            if isinstance(view, dict) and (words := heard_words(view))
        )
    if instrumental is not None and len(candidates) == 1:
        backing = np.pad(
            instrumental[: len(samples)], (0, max(0, len(samples) - len(instrumental)))
        )
        candidates.append(heard_words(recognize(samples + backing)))
    return candidates


def phrase_coverage(lyrics: str, heard: Sequence[tuple[str, float, float]]) -> int:
    lines = [line for line in lyrics.splitlines() if _lyrics_key(line)]
    expected = Counter(_lyrics_key(line) for line in lines)
    lengths = {_lyrics_key(line): len(line.split()) for line in lines}
    recognized = Counter(
        _lyrics_key(text)
        for text, _, _ in performed_phrases(
            lyrics, [word for word, _, _ in heard], threading.Event()
        )
    )
    return sum(lengths[key] * min(count, recognized[key]) for key, count in expected.items())


def serialize(segments: Iterable[Segment], offset: float = 0.0) -> dict[str, object]:
    serialized = [
        {
            "text": segment.text,
            "words": [
                {"word": word.word, "start": word.start + offset, "end": word.end + offset}
                for word in segment.words or []
            ],
        }
        for segment in segments
    ]
    return {"text": "".join(str(item["text"]) for item in serialized), "segments": serialized}


def heard_words(result: Mapping[str, object], *, include_untimed: bool = False) -> list[HeardWord]:
    heard: list[HeardWord] = []
    segments = result.get("segments")
    for segment in segments if isinstance(segments, list) else []:
        words = segment.get("words") if isinstance(segment, dict) else None
        for word in words if isinstance(words, list) else []:
            key = _key(str(word.get("word", "")))
            if key and (include_untimed or float(word["start"]) < float(word["end"])):
                heard.append((key, float(word["start"]), float(word["end"])))
    return heard


def heard_timings(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[AlignedWord] | None = None,
    *,
    minimum_block: int = 1,
    windows: Sequence[Window] = (),
) -> dict[int, tuple[float, float]]:
    timings = {
        block.a + offset: (heard[block.b + offset][1], heard[block.b + offset][2])
        for block in _matching_blocks(words, heard, whole)
        if block.size >= minimum_block
        for offset in range(block.size)
    }
    return {
        index: interval
        for index, interval in timings.items()
        if not windows
        or any(
            window.first <= index < window.last and window.start <= interval[0] < window.end
            for window in windows
        )
    }


def independent_timings(
    words: list[str], views: Sequence[list[tuple[str, float, float]]], timed: Sequence[AlignedWord]
) -> dict[int, tuple[float, float]]:
    """Keep complementary unprompted views, matched to the final acoustic positions."""
    matches = [heard_timings(words, view, timed) for view in views]
    return {
        index: min(
            (match[index] for match in matches if index in match),
            key=lambda interval: abs(timed[index].start - interval[0]),
        )
        for index in set().union(*(match.keys() for match in matches))
    }


def recover_leading_words(
    lyrics: str,
    whole: Sequence[AlignedWord],
    heard: list[tuple[str, float, float]],
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]],
) -> list[tuple[str, float, float]]:
    """Recheck a missed entry when three acoustic cores precede the full-song ASR."""
    prefix = whole[:3]
    if (
        len(prefix) < 3
        or not heard
        or any(word.score < 0.3 for word in prefix)
        or prefix[-1].end + _MARGIN >= heard[0][1]
    ):
        return heard
    start = max(0.0, prefix[0].start - _MARGIN)
    end = min(start + CHUNK_LENGTH, heard[0][2] + _MARGIN)
    try:
        results = recognize([(start, end, None)]).get("contexts", [])
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return heard
    local = heard_words(results[0]) if isinstance(results, list) and results else []
    if [word for word, _, _ in local[:3]] != [_key(word.text) for word in prefix]:
        return heard
    combined = [*local, *(word for word in heard if word[1] >= end)]
    return (
        combined if phrase_coverage(lyrics, combined) >= phrase_coverage(lyrics, heard) else heard
    )


def context_windows(
    words: Sequence[str], windows: Sequence[Window], activity: np.ndarray
) -> list[tuple[float, float, str]]:
    """Include a neighbouring phrase so a missed short reply is not decoded in isolation.

    Pauses select recognition context only; they never trim the sounding word.
    """
    pauses = [(a * _STEP, b * _STEP) for a, b in _runs(activity, False) if b - a >= 30]
    contexts = []
    for index, window in enumerate(windows):
        previous, following = windows[max(0, index - 1)], windows[min(len(windows) - 1, index + 1)]
        start = max(
            0.0,
            previous.start,
            max((b - _MARGIN for _, b in pauses if b <= window.start), default=0.0),
        )
        end = min(
            following.end,
            next(
                (a + _MARGIN for a, _ in pauses if a > window.end),
                following.end,
            ),
        )
        contexts.append(
            (
                start,
                end if end > start else window.end,
                " ".join(words[previous.first : following.last]),
            )
        )
    return contexts


def contextual_guidance(
    words: Sequence[str],
    windows: Sequence[Window],
    whole: Sequence[AlignedWord],
    timings: dict[int, tuple[float, float]],
    activity: np.ndarray,
    recognize: Callable[[Sequence[tuple[float, float, str]]], Mapping[str, object]],
) -> tuple[list[Window], dict[int, tuple[float, float]]]:
    windows, timings = _ending_guidance(words, windows, timings, activity, recognize)
    missing = [
        i
        for i, w in enumerate(windows)
        if any(
            k not in timings
            and (whole[k].score <= _PREFERENCE or whole[k].start < w.start or whole[k].end > w.end)
            for k in range(w.first, w.last)
        )
    ]
    if not missing:
        return list(windows), timings
    contexts = context_windows(words, windows, activity)
    try:
        results = recognize([contexts[i] for i in missing]).get("contexts", [])
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return list(windows), timings
    revised, supported = list(windows), dict(timings)
    for index, result in zip(missing, results if isinstance(results, list) else []):
        # Validate suffixes in context when the first ASR put the next line on a cut-off suffix.
        window = replace(windows[index], end=max(windows[index].end, contexts[index][1]))
        phrase, local = recognized_phrase(
            window, words[window.first : window.last], heard_words(result), _MARGIN
        )
        if phrase is not None and len(local) > sum(
            k in timings for k in range(window.first, window.last)
        ):
            revised[index] = phrase_window(
                window, phrase, whole[window.first].start, local.get(window.last - 1), _MARGIN
            )
            supported.update(local)
    return revised, supported


def _ending_window(
    words: Sequence[str],
    windows: Sequence[Window],
    timings: Mapping[int, tuple[float, float]],
    activity: np.ndarray,
) -> tuple[int, Window] | None:
    if not windows:
        return None
    first, last = len(windows) - 1, windows[-1]
    text = words[last.first : last.last]
    while first > 0 and words[windows[first - 1].first : windows[first - 1].last] == text:
        first -= 1
    if (
        first == len(windows) - 1
        or all(k in timings for k in range(windows[first].first, last.last))
        or not activity.any()
    ):
        return None
    previous = windows[max(0, first - 1)]
    start = previous.heard_start if previous.heard_start is not None else previous.start
    # Include a complete decoder window and its trailing silence, rather than cutting at reverb.
    end = min(len(activity) * _STEP, max(last.end, start + CHUNK_LENGTH))
    return first, replace(windows[first], last=last.last, end=end)


def _ending_guidance(
    words: Sequence[str],
    windows: Sequence[Window],
    timings: dict[int, tuple[float, float]],
    activity: np.ndarray,
    recognize: Callable[[Sequence[tuple[float, float, str]]], Mapping[str, object]],
) -> tuple[list[Window], dict[int, tuple[float, float]]]:
    """Decode repeated outro replies together so compressed ASR times cannot steal an occurrence."""
    revised, supported = list(windows), dict(timings)
    ending = _ending_window(words, windows, timings, activity)
    if ending is None:
        return revised, supported
    first, group = ending
    previous = windows[max(0, first - 1)]
    start = previous.heard_start if previous.heard_start is not None else previous.start
    prompt = " ".join(dict.fromkeys(words[previous.first : group.last]))
    try:
        results = recognize([(start, group.end, prompt)]).get("contexts", [])
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return revised, supported
    result = results[0] if isinstance(results, list) and results else {}
    excerpt = words[group.first : group.last]
    margin = _MARGIN * (len(windows) - first)
    _, local = recognized_phrase(group, excerpt, heard_words(result), margin)
    if len(local) < len(excerpt) or len(local) <= sum(
        k in timings for k in range(group.first, group.last)
    ):
        return revised, supported
    supported.update(local)
    for index in range(first, len(windows)):
        revised[index] = _ending_position(windows[index], local)
    return revised, supported


def _ending_position(window: Window, local: Mapping[int, tuple[float, float]]) -> Window:
    start, end = local[window.first][0], local[window.last - 1][1]
    # A span containing the established entry may include the preceding vowel.
    contains_entry = (
        window.heard_start is not None and start <= window.heard_start <= local[window.first][1]
    )
    return replace(
        window,
        start=window.start if contains_entry else max(0, start - _MARGIN),
        end=end + _MARGIN,
        heard_start=window.heard_start if contains_entry else start,
    )


def _word_payload(
    word: AlignedWord, heard_timing: tuple[float, float] | None, *, recovered: bool = False
) -> dict[str, float | str | list[float] | list[str]]:
    reasons = {
        "RateReviewRetimed": recovered,
        "ApproximateAlignment": word.score <= 0.0,
        "RecognizedWord": heard_timing is not None
        and heard_timing[0] < heard_timing[1]
        and heard_timing[0] - _MARGIN <= word.start <= heard_timing[1] + _MARGIN,
        "AsrCtcBoundaryDisagreement": heard_timing is not None
        and max(abs(word.start - heard_timing[0]), abs(word.end - heard_timing[1])) > _MARGIN,
    }
    return {
        "text": word.text,
        "start": round(word.start, 3),
        "end": round(word.end, 3),
        "confidence": word.score,
        "letters": list(word.letters),
        "diagnostics": [reason for reason, present in reasons.items() if present],
    }


def alignment_payload(
    words: Sequence[AlignedWord],
    timings: Mapping[int, tuple[float, float]],
    *,
    recovered: frozenset[int] = frozenset(),
) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
    return {
        "words": [
            _word_payload(word, timings.get(index), recovered=index in recovered)
            for index, word in enumerate(words)
        ]
    }


def guidance_positions(
    timings: Mapping[int, tuple[float, float]], windows: Sequence[Window]
) -> dict[int, float]:
    return {
        window.first: window.heard_start for window in windows if window.heard_start is not None
    } | {index: times[0] for index, times in timings.items()}


def unhinted_windows(
    windows: Sequence[Window], whole: Sequence[AlignedWord], margin: float
) -> list[Window]:
    """Leave search space for text absent from timed catalogue entries.

    A known line's coarse end is the next known line's start, so it also includes any
    intervening untimed lyrics. Recover their start from the refined neighbour and CTC.
    These are search bounds, never a decision about the end of singing.
    """
    return [
        replace(
            window,
            start=max(
                0.0,
                windows[index - 1].start if index else 0.0,
                min(
                    windows[index - 1].end if index else window.start,
                    whole[window.first].start - margin,
                ),
            ),
        )
        if window.heard_start is None
        else window
        for index, window in enumerate(windows)
    ]
