from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from collections import Counter
from dataclasses import replace
from itertools import groupby
import threading
from pathlib import Path
from types import MappingProxyType

import numpy as np
import torch
from faster_whisper.transcribe import Segment
from whisper.audio import CHUNK_LENGTH

from backend.ai_worker.ctc import AlignedWord, Window, _CRAMMED_WORD_SECONDS, _PREFERENCE, _evenly
from backend.ai.domain import WordTiming
from backend.processing.reporting import _timing_load, rate_reviews
from backend.ai_worker.timing import _bridged, _runs
from backend.ai_worker.ctc_tokens import _character_tokens
from backend.ai_worker.word_guidance import _key, _matching_blocks, phrase_window, recognized_phrase
from backend.lyrics.phrases import _line_matches, _lyrics_key, performed_phrases

_MARGIN = 0.6
_STEP = 0.01
HeardWord = tuple[str, float, float]


def backing_overlap_indices(
    words: Sequence[AlignedWord],
    views: Sequence[list[HeardWord]],
    activity: np.ndarray,
    periodicity: np.ndarray,
    *,
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]] | None = None,
) -> frozenset[int]:
    """Keep proven solo replies, excluding weak simultaneous copies over an independently heard lead."""
    known = {_key(word.text) for word in words if "AcousticRepeatRetimed" in word.diagnostics}
    if len(views) < 2 or not known:
        return frozenset()
    backing = set()
    for index, word in enumerate(words):
        if (
            _key(word.text) not in known
            or "AcousticRepeatRetimed" in word.diagnostics
            or word.score > _PREFERENCE
            or word.end - word.start < 0.25
        ):
            continue
        first, last = max(0, round(word.start / _STEP)), min(len(activity), round(word.end / _STEP))
        if np.count_nonzero(activity[first:last] & (periodicity[first:last] >= 0.7)) >= 10:
            continue
        phrase = words[index + 1 : index + 5]
        if len(phrase) < 3:
            continue
        window = Window(
            index + 1,
            index + 1 + len(phrase),
            word.start,
            phrase[-1].end + _MARGIN,
            phrase[0].start,
        )
        texts = [item.text for item in phrase]
        matches = [(view, recognized_phrase(window, texts, view, _MARGIN)[1]) for view in views]
        supported = [
            intervals for _, intervals in matches if index + 1 in intervals and len(intervals) >= 2
        ]
        if not supported:
            continue
        context_end = min(
            window.end,
            max(end for intervals in supported for _, end in intervals.values()) + _MARGIN,
        )
        context_start = max(
            0.0, context_end - CHUNK_LENGTH,
            words[max(0, index - len(phrase))].start - _MARGIN,
        )
        agreed = []
        replaced_view = False
        for view, intervals in matches:
            tolerance = 0.0
            if any(
                key == _key(word.text) and start < word.end and end > word.start
                for key, start, end in view
            ):
                break
            lead = intervals.get(index + 1)
            if (lead is None or len(intervals) < 2) and recognize is not None and not replaced_view:
                try:
                    results = recognize([(context_start, context_end, None)]).get(
                        "contexts", []
                    )
                except (FileNotFoundError, OSError, RuntimeError, ValueError):
                    break
                local = heard_words(results[0]) if (
                    isinstance(results, list) and results and isinstance(results[0], dict)
                ) else []
                replaced_view = True
                if any(
                    key == _key(word.text) and start < word.end and end > word.start
                    for key, start, end in local
                ):
                    break
                _, intervals = recognized_phrase(
                    window, texts, local, _MARGIN
                )
                lead = intervals.get(index + 1)
                tolerance = _MARGIN
            if lead is None or len(intervals) < 2:
                break
            lead_start = lead[0] - tolerance
            overlap = max(0.0, min(word.end, lead[1]) - max(word.start, lead_start))
            if overlap < (word.end - word.start) / 2:
                break
            agreed.append(max(word.start, lead_start))
        if len(agreed) == len(views) and max(agreed) - min(agreed) <= _MARGIN:
            backing.add(index)
    return frozenset(backing)


def with_acoustic_repeats(
    words: list[AlignedWord],
    onsets: Sequence[float],
    acoustic: tuple[np.ndarray, np.ndarray],
    activity: np.ndarray,
    levels: np.ndarray,
    heard: Mapping[int, tuple[float, float]],
) -> list[AlignedWord]:
    """Retain every written repeat, recovering short consonant breaks missed by loudness onsets."""
    harmonic, periodicity = acoustic
    result = list(words)

    def core(start: float, end: float) -> np.ndarray:
        first, last = max(0, round(start / _STEP)), min(len(activity), round(end / _STEP))
        return harmonic[first:last][activity[first:last] & (periodicity[first:last] >= 0.7)]

    for _, grouped in groupby(range(len(words)), key=lambda index: _key(words[index].text)):
        indices = list(grouped)
        first, last = indices[0], indices[-1]
        if (
            len(indices) < 2
            or last + 1 == len(words)
            or _timing_load(words[first].text)[1] != 1
            or words[first].end - words[first].start < 0.25
            or any(index in heard or words[index].score > _PREFERENCE for index in indices)
        ):
            continue
        following = words[last + 1]
        left = max(words[first - 1].end if first else 0, words[first].start - _MARGIN)
        entries = [entry for entry in onsets if left <= entry < following.start]
        if not entries or abs(entries[0] - words[first].start) > _MARGIN:
            continue
        reference = core(
            entries[0], min(words[first].end, entries[1] if len(entries) > 1 else following.start)
        )
        negative = core(following.start, following.end)
        if min(len(reference), len(negative)) < 10:
            continue
        matches: list[tuple[float, float]] = []
        for start, stop in zip(entries, [*entries[1:], following.start]):
            features = core(start, stop)
            if len(features) < 10:
                continue
            same = max(0.0, float(np.median(1 - (features @ reference.T).max(axis=1))))
            other = max(0.0, float(np.median(1 - (features @ negative.T).max(axis=1))))
            if same > 0.05 or same >= other / 2:
                continue
            frame_first, frame_last = round(start / _STEP), round(stop / _STEP)
            sounding = (
                activity[frame_first:frame_last]
                & (periodicity[frame_first:frame_last] >= 0.5)
                & (
                    levels[frame_first:frame_last]
                    >= np.percentile(levels[frame_first:frame_last], 95) - 20
                )
            )
            # Bridge detector flicker, but retain a consonant-sized interruption even
            # when its energy never falls far enough for a new loudness onset.
            islands = [(a, b) for a, b in _runs(_bridged(sounding, 2), True) if b - a >= 10]
            if islands:
                bounds = [
                    float(start),
                    *((frame_first + end) * _STEP for _, end in islands[:-1]),
                    (frame_first + int(np.flatnonzero(sounding)[-1]) + 1) * _STEP,
                ]
                matches.extend(zip(bounds, bounds[1:]))
        if len(matches) != len(indices):
            continue
        for index, (start, end) in zip(indices, matches):
            word = words[index]
            flags = tuple(
                flag
                for flag in word.diagnostics
                if flag
                not in {
                    "TimingReviewRequired",
                    "OnsetReviewRequired",
                    "BoundaryConflict",
                    "BoundaryClipped",
                }
            )
            result[index] = replace(
                word,
                start=start,
                end=end,
                letters=_evenly([word.text], start, end)[0].letters,
                diagnostics=(*flags, "AcousticRepeatRetimed", "ApproximateLetterTiming"),
            )
    return result


def recover_vocalizations(
    words: Sequence[AlignedWord],
    scores: torch.Tensor | None,
    step: float,
    activity: np.ndarray,
    periodicity: np.ndarray,
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]],
) -> list[AlignedWord]:
    """Recover or extend held vowels only when recognition agrees with CTC and phonation."""
    if scores is None or not words or not activity.any():
        return []
    vowels = [token[0] for token in _character_tokens("aeiou")]
    probabilities = scores.exp()
    # A CTC blank is an unlabelled frame, not a competing sung consonant.
    vowel_support = probabilities[:, vowels] / probabilities[:, 1:].sum(
        dim=1, keepdim=True
    ).clamp_min(1e-12)
    vowel_support = vowel_support.masked_fill(probabilities[:, vowels] <= _PREFERENCE, 0)
    gaps: list[tuple[float, float, int | None]] = list(
        zip(
            [0.0, *(word.end for word in words)],
            [*(word.start for word in words), len(activity) * _STEP],
            [None] * (len(words) + 1),
        )
    )
    for index, word in enumerate(words):
        text = _key(word.text)
        if text and len(set(text)) == 1 and _character_tokens(text[0])[0] in [[v] for v in vowels]:
            gaps.append(
                (
                    words[index - 1].end if index else 0,
                    words[index + 1].start if index + 1 < len(words) else len(activity) * _STEP,
                    index,
                )
            )
    candidates = []
    for left, right, owner in gaps:
        first, last = max(0, round(left / _STEP)), min(len(activity), round(right / _STEP))
        flags = activity[first:last] & (periodicity[first:last] >= 0.5)
        for run_first, run_last in _runs(_bridged(flags, round(0.3 / _STEP)), True):
            if (run_last - run_first) * _STEP < 0.8 or flags[run_first:run_last].mean() < 0.6:
                continue
            begin, finish = (first + run_first) * _STEP, (first + run_last) * _STEP
            if owner is not None and not (
                begin < words[owner].end
                and words[owner].start < finish
                and finish - words[owner].end >= 0.3
            ):
                continue
            local = vowel_support[round(begin / step) : round(finish / step)]
            if local.numel() and float(local.max()) >= 0.5:
                context_start = max(left, begin - _MARGIN)
                candidates.append(
                    (
                        begin,
                        finish,
                        context_start,
                        min(right, finish + _MARGIN, context_start + CHUNK_LENGTH),
                        owner,
                    )
                )
    extended_runs = [
        (begin, finish) for begin, finish, _, _, owner in candidates if owner is not None
    ]
    candidates = [
        item
        for item in candidates
        if item[4] is not None
        or not any(begin <= item[0] and item[1] <= finish for begin, finish in extended_runs)
    ]
    if not candidates:
        return []
    try:
        results = recognize([(start, end, None) for _, _, start, end, _ in candidates]).get(
            "contexts", []
        )
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return []
    recovered: list[AlignedWord] = []
    for (begin, finish, _, _, owner), result in zip(
        candidates, results if isinstance(results, list) else []
    ):
        segments = result.get("segments", [])
        if not isinstance(segments, list):
            continue
        segments = [
            segment for segment in segments
            if float(segment.get("start", begin)) < finish
            and float(segment.get("end", finish)) > begin
        ]
        recognized = "".join(_key(str(segment.get("text", ""))) for segment in segments)
        for segment in segments:
            text = _key(str(segment.get("text", "")))
            if not text or len(set(text)) != 1:
                continue
            tokens = _character_tokens(text[0])[0]
            if len(tokens) != 1 or tokens[0] not in vowels:
                continue
            start = max(begin, float(segment["start"]) - _MARGIN)
            end = min(finish, float(segment["end"]) + _MARGIN)
            if set(recognized) == {text[0]} and start < end:
                start, end = begin, finish
            local = scores[round(start / step) : round(end / step), tokens[0]]
            if end - start < 0.8 or not local.numel():
                continue
            confidence = float(local.max().exp())
            support = vowel_support[
                round(start / step) : round(end / step), vowels.index(tokens[0])
            ]
            if float(support.max()) >= 0.5:
                if owner is not None:
                    word = words[owner]
                    if (
                        set(recognized) != {text[0]}
                        or _character_tokens(_key(word.text)[0])[0] != tokens
                    ):
                        continue
                    recovered.append(
                        replace(
                            word,
                            end=max(word.end, end),
                            letters=_evenly([word.text], word.start, max(word.end, end))[0].letters,
                            diagnostics=(
                                *word.diagnostics,
                                "VocalizationRetimed",
                                "ApproximateLetterTiming",
                            ),
                        )
                    )
                    break
                previous = recovered[-1] if recovered else None
                if previous is not None and start < previous.end:
                    if previous.text == text[0].upper():
                        recovered[-1] = replace(
                            previous,
                            end=max(previous.end, end),
                            score=max(previous.score, confidence),
                        )
                else:
                    recovered.append(
                        AlignedWord(
                            text[0].upper(),
                            start,
                            end,
                            (start,),
                            confidence,
                            ("RecoveredVocalization",),
                        )
                    )
    return recovered


def boundary_conflicts(words: Sequence[AlignedWord]) -> set[int]:
    return {index for index, word in enumerate(words) if "BoundaryConflict" in word.diagnostics} | {
        index + offset
        for index, (left, right) in enumerate(zip(words, words[1:]))
        if left.end > right.start + 0.02 or left.start >= right.start
        for offset in (0, 1)
    }


def rate_review_indices(
    words: Sequence[AlignedWord],
    lyrics: str,
    *,
    heard: Mapping[int, tuple[float, float]] = MappingProxyType({}),
    activity: np.ndarray | None = None,
) -> set[int]:
    """Review spelling outliers and contradicted acoustic spans, never impose a speech minimum."""
    reviews = rate_reviews(
        [
            WordTiming(w.text, w.start, w.end, w.score, tuple(w.letters), w.diagnostics)
            for w in words
        ],
        lyrics,
    )
    indices = {
        index for first, last in reviews for index in range(first, last)
    } | boundary_conflicts(words)
    indices |= {
        index
        for index, word in enumerate(words)
        if _short_word_needs_review(word, heard.get(index))
    }
    if activity is not None:
        for index, (start, end) in heard.items():
            if not 0 <= index < len(words):
                continue
            word = words[index]
            missing = [(start, min(end, word.start)), (max(start, word.end), end)]
            if any(
                last - first > 0.08
                and len(frames := activity[max(0, round(first / _STEP)) : round(last / _STEP)])
                and float(frames.mean()) >= 0.6
                for first, last in missing
            ):
                indices.add(index)
    return indices


def _short_word_needs_review(word: AlignedWord, interval: tuple[float, float] | None) -> bool:
    # Weak CTC support is ambiguous; agreeing independent boundaries can
    # confirm a genuinely fast word without a redundant local review.
    return (
        any(char.isalnum() for char in word.text)
        and word.score <= _PREFERENCE
        and word.end - word.start + 1e-9 < _CRAMMED_WORD_SECONDS
        and (
            word.score <= 0
            or interval is None
            or max(abs(word.start - interval[0]), abs(word.end - interval[1])) > 2 * _STEP + 1e-9
        )
    )


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
    # A complete single phrase attains full coverage without searching all substrings.
    # One character only ties the unmatched path after the phrase-selection penalty.
    if len(lines) == 1:
        key = _lyrics_key(lines[0])
        normalized = [_lyrics_key(word) for word, _, _ in heard]
        if len(key) > 1 and key == "".join(normalized):
            return lengths[key]
        # Coverage counts this phrase at most once. With one candidate each entry
        # costs log2(2) = 1, so any support above 1 beats the unmatched path.
        if normalized and any(support > 1 for _, support in _line_matches(key, normalized, 0)):
            return lengths[key]
        # Zero-score paths retain the exhaustive matcher's original tie ordering.
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
    word: AlignedWord,
    heard_timing: tuple[float, float] | None,
    *,
    recovered: bool = False,
    review_required: bool = False,
) -> dict[str, float | str | list[float] | list[str]]:
    reasons = {
        "RateReviewRetimed": recovered,
        "TimingReviewRequired": review_required,
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
        "diagnostics": list(
            dict.fromkeys(
                [*word.diagnostics, *(reason for reason, present in reasons.items() if present)]
            )
        ),
    }


def alignment_payload(
    words: Sequence[AlignedWord],
    timings: Mapping[int, tuple[float, float]],
    *,
    recovered: frozenset[int] = frozenset(),
    reviewed: frozenset[int] = frozenset(),
) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
    return {
        "words": [
            _word_payload(
                word,
                timings.get(index),
                recovered=index in recovered,
                review_required=index in reviewed,
            )
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
