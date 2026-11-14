from __future__ import annotations
import difflib
import threading
from collections import Counter
from collections.abc import Mapping, Sequence
import numpy as np
from backend.lyrics.discovery import performed_phrases
from backend.ai_worker.ctc import (
    AlignedWord,
    Window,
    _PREFERENCE,
)
from backend.ai_worker.timing import (
    vocal_onsets,
)
from backend.ai_worker.recognition import (
    HeardWord,
    unhinted_windows,
    heard_timings as _heard_timings,
)
from backend.ai_worker.word_guidance import (
    _key,
    _matching_blocks,
    phrase_window,
    recognized_phrase,
)

_SAMPLE_RATE = 16_000


_MINIMUM_BLOCK = 3


_MARGIN_SECONDS = 0.6


_HOP = 160


_ONSET_SNAP_LATER_SECONDS = 0.3


_ONSET_LEAD_SECONDS = 0.05


_CATALOG_SHIFT_MINIMUM_SECONDS = 0.3


_CATALOG_SHIFT_MAXIMUM_SPREAD_SECONDS = 0.5


_CATALOG_SHIFT_MINIMUM_LINES = 5


def _windows(
    words: list[str],
    heard: list[tuple[str, float, float]],
    total: float,
    whole: Sequence[AlignedWord] | None = None,
    *,
    blocks: Sequence[difflib.Match] | None = None,
) -> list[Window]:
    """Pin matching runs to ASR time; put intervening text in the audio between those runs."""
    if blocks is None:
        blocks = [
            block for block in _matching_blocks(words, heard, whole) if block.size >= _MINIMUM_BLOCK
        ]
    if not blocks:
        return [Window(0, len(words), 0.0, total)]
    # A long exact match still contains separate sung occurrences. A single CTC
    # path can skip the first repeat and crush the last one despite correct ASR.
    phrases: list[difflib.Match] = []
    for block in blocks:
        first = 0
        for last in range(1, block.size + 1):
            if (
                last == block.size
                or last - first >= _MINIMUM_BLOCK
                and (
                    heard[block.b + last][1] - heard[block.b + last - 1][2] >= 0.35
                    or heard[block.b + last][1] - heard[block.b + first][1] >= 12
                )
            ):
                phrases.append(difflib.Match(block.a + first, block.b + first, last - first))
                first = last
    windows: list[Window] = []
    text_cursor, audio_cursor = 0, 0.0
    for block in phrases:
        start, end = (
            heard[block.b][1] - _MARGIN_SECONDS,
            heard[block.b + block.size - 1][2] + _MARGIN_SECONDS,
        )
        if block.a > text_cursor:
            windows.append(Window(text_cursor, block.a, audio_cursor, max(start, audio_cursor)))
        windows.append(
            Window(
                block.a,
                block.a + block.size,
                max(start, 0.0),
                end,
                heard[block.b][1],
            )
        )
        text_cursor, audio_cursor = block.a + block.size, end
    if text_cursor < len(words):
        windows.append(Window(text_cursor, len(words), audio_cursor, total))
    return windows


def _line_first_words(
    words: list[str], hints: Sequence[Mapping[str, object]]
) -> list[tuple[int, float, str]]:
    """(index of the line's first lyric word, timestamp, text) for every catalog line found in order."""
    keys = [_key(word) for word in words]
    found: list[tuple[int, float, str]] = []
    cursor = 0
    for item in hints:
        start, text = item.get("start"), item.get("text")
        if not (
            isinstance(start, (int, float))
            and not isinstance(start, bool)
            and isinstance(text, str)
        ):
            continue
        line = [_key(word) for word in text.split() if _key(word)]
        first = next(
            (
                position
                for position in range(cursor, len(keys) - len(line) + 1)
                if keys[position : position + len(line)] == line
            ),
            None,
        )
        if first is None or not line:
            continue
        found.append((first, float(start), text))
        cursor = first + len(line)
    return found


def _shifted_hints(
    words: list[str],
    hints: Sequence[Mapping[str, object]],
    whole: Sequence[AlignedWord],
    heard: Sequence[HeardWord] = (),
) -> list[dict[str, object]]:
    """Correct stale cues using independent recognition or a well-supported adjacent CTC path."""
    lines = _line_first_words(words, hints)
    differences = [whole[first].start - start for first, start, _ in lines]
    shift = 0.0
    if len(differences) >= _CATALOG_SHIFT_MINIMUM_LINES:
        middle = float(np.median(differences))
        spread = float(np.percentile(differences, 75) - np.percentile(differences, 25))
        if (
            abs(middle) >= _CATALOG_SHIFT_MINIMUM_SECONDS
            and spread <= _CATALOG_SHIFT_MAXIMUM_SPREAD_SECONDS
        ):
            shift = middle
    supported = _heard_timings(words, list(heard), whole, minimum_block=_MINIMUM_BLOCK)
    result: list[dict[str, object]] = []
    previous_entry: float | None = None
    for line_index, (first, start, text) in enumerate(lines):
        entry = start + shift
        interval = supported.get(first)
        phrase_support = {
            _key(words[index])
            for index in range(first, first + len(text.split()))
            if index in supported
        }
        if interval is not None and len(phrase_support) >= _MINIMUM_BLOCK:
            if not interval[0] - _MARGIN_SECONDS <= entry <= interval[1] + _MARGIN_SECONDS:
                entry = interval[0]
        elif line_index and previous_entry is not None and not phrase_support:
            previous_first, _, previous_text = lines[line_index - 1]
            if (
                previous_first + len(previous_text.split()) == first
                and abs(whole[previous_first].start - previous_entry) <= _MARGIN_SECONDS
                and whole[first - 1].end > entry + _MARGIN_SECONDS
                and whole[first].start > entry + _MARGIN_SECONDS
                and min(whole[first - 1].score, whole[first].score) > _PREFERENCE
                and sum(word.score > _PREFERENCE for word in whole[previous_first:first])
                >= _MINIMUM_BLOCK
                and sum(
                    word.score > _PREFERENCE for word in whole[first:first + len(text.split())]
                ) >= _MINIMUM_BLOCK
            ):
                entry = whole[first].start
        # A repeated phrase must not borrow the timestamp of a neighbouring occurrence.
        lower = previous_entry if previous_entry is not None else float("-inf")
        if line_index:
            lower = max(lower, lines[line_index - 1][1] + shift)
        upper = lines[line_index + 1][1] + shift if line_index + 1 < len(lines) else float("inf")
        if not lower < entry < upper:
            entry = start + shift
        result.append({"start": entry, "text": text})
        previous_entry = entry
    return result


def _line_start(hint: float, onsets: np.ndarray) -> tuple[float, bool]:
    """Where a catalog line's window opens, and whether a clear voice entry confirmed it."""
    near = onsets[(onsets >= hint - _MARGIN_SECONDS) & (onsets <= hint + _ONSET_SNAP_LATER_SECONDS)]
    if len(near):
        return float(near[np.argmin(np.abs(near - hint))]) - _ONSET_LEAD_SECONDS, True
    return hint - _MARGIN_SECONDS, False


def _hint_windows(
    lyrics: str,
    hints: Sequence[Mapping[str, object]],
    total: float,
    onsets: np.ndarray = np.empty(0),
) -> list[Window]:
    words = lyrics.split()
    lines = _line_first_words(words, hints)
    opens = [_line_start(start, onsets) for _, start, _ in lines]
    windows: list[Window] = []
    cursor, audio_cursor, matched = 0, 0.0, 0
    for index, (first, hint, text) in enumerate(lines):
        last = first + sum(1 for word in text.split() if _key(word))
        window_start = max(0.0, opens[index][0])
        window_end = _line_end(index, lines, opens, total)
        if first > cursor:
            windows.append(Window(cursor, first, audio_cursor, max(audio_cursor, window_start)))
        windows.append(
            Window(
                first,
                last,
                window_start,
                window_end,
                window_start + _ONSET_LEAD_SECONDS if opens[index][1] else hint,
            )
        )
        cursor, audio_cursor, matched = last, window_end, matched + last - first
    if cursor < len(words):
        windows.append(Window(cursor, len(words), audio_cursor, total))
    return windows if matched >= _MINIMUM_BLOCK else []


def _line_end(
    index: int,
    lines: Sequence[tuple[int, float, str]],
    opens: Sequence[tuple[float, bool]],
    total: float,
) -> float:
    """A line's window closes where the next line's voice enters, or a margin after its timestamp."""
    if index + 1 >= len(lines):
        return total
    if opens[index + 1][1]:
        return opens[index + 1][0]
    return min(total, lines[index + 1][1] + _MARGIN_SECONDS)


def _alignment_windows(
    lyrics: str,
    timing_hints: Sequence[Mapping[str, object]],
    heard: list[tuple[str, float, float]],
    whole: Sequence[AlignedWord],
    samples: np.ndarray,
) -> list[Window]:
    words, total = lyrics.split(), len(samples) / _SAMPLE_RATE
    if timing_hints:
        hints = _shifted_hints(words, timing_hints, whole, heard)
        onsets = vocal_onsets(samples, _SAMPLE_RATE, _HOP)
        windows = _hint_windows(lyrics, hints, total, onsets)
        if windows:
            supported = _heard_timings(words, heard, whole, minimum_block=_MINIMUM_BLOCK)
            return unhinted_windows(
                [
                    phrase_window(
                        window,
                        recognized_phrase(
                            window,
                            words[window.first : window.last],
                            heard,
                            _MARGIN_SECONDS,
                            allow_utterance=window.first - 1 in supported
                            and window.last in supported,
                        )[0],
                        whole[window.first].start,
                        supported.get(window.last - 1),
                        _MARGIN_SECONDS,
                    )
                    for window in windows
                ],
                whole,
                _MARGIN_SECONDS,
            )
    return _phrase_windows(lyrics, heard, total, whole) or _windows(words, heard, total, whole)


def _phrase_windows(
    lyrics: str,
    heard: list[tuple[str, float, float]],
    total: float,
    whole: Sequence[AlignedWord],
) -> list[Window]:
    if len(lyrics.splitlines()) < 2:
        return []
    phrases = performed_phrases(lyrics, [word for word, _, _ in heard], threading.Event())
    lines = [line for line in lyrics.splitlines() if line.split()]
    firsts = [0]
    for line in lines:
        firsts.append(firsts[-1] + len(line.split()))
    heard_lines = [(text, heard[first][1], heard[last - 1][2]) for text, first, last in phrases]
    matches = _matching_blocks(
        lines,
        [(_key(text), start, end) for text, start, end in heard_lines],
        [whole[first] for first in firsts[:-1]],
    )
    expanded: list[tuple[str, float, float]] = []
    blocks: list[difflib.Match] = []
    for match in matches:
        for offset in range(match.size):
            text, start, end = heard_lines[match.b + offset]
            words = text.split()
            blocks.append(difflib.Match(firsts[match.a + offset], len(expanded), len(words)))
            expanded.extend(
                (
                    _key(word),
                    start + (end - start) * i / len(words),
                    start + (end - start) * (i + 1) / len(words),
                )
                for i, word in enumerate(words)
            )
    if not blocks:
        return []
    _unique_anchors(lyrics.split(), heard, blocks, expanded)
    return _windows(lyrics.split(), expanded, total, blocks=sorted(blocks, key=lambda b: b.a))


def _unique_anchors(
    words: list[str],
    heard: list[tuple[str, float, float]],
    blocks: list[difflib.Match],
    expanded: list[tuple[str, float, float]],
) -> None:
    keys = [_key(word) for word in words]
    counts, heard_counts = Counter(keys), Counter(word for word, _, _ in heard)
    occupied = {block.a + i for block in blocks for i in range(block.size)}
    positions = {word: index for index, (word, _, _) in enumerate(heard)}
    for index, key in enumerate(keys):
        if index not in occupied and counts[key] == heard_counts[key] == 1:
            candidate = heard[positions[key]]
            before = max(
                (expanded[b.b + b.size - 1][1] for b in blocks if b.a + b.size <= index),
                default=0.0,
            )
            after = min((expanded[b.b][2] for b in blocks if b.a > index), default=float("inf"))
            # ASR may skip this occurrence: require the surrounding phrases even for unique spelling.
            if before <= candidate[1] <= candidate[2] <= after:
                blocks.append(difflib.Match(index, len(expanded), 1))
                expanded.append(candidate)
