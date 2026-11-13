from __future__ import annotations
from collections.abc import Sequence
from dataclasses import replace
import difflib
from difflib import SequenceMatcher
import numpy as np
from backend.ai_worker import ctc
from backend.lyrics.discovery import _line_matches, _lyrics_key


def recognized_phrase(
    window: ctc.Window,
    words: Sequence[str],
    heard: Sequence[tuple[str, float, float]],
    margin: float,
    *,
    allow_utterance: bool = False,
) -> tuple[ctc.Window | None, dict[int, tuple[float, float]]]:
    """Use local phrase spelling support, including ASR splits and misspellings.

    Catalogue time selects the occurrence; the same character evidence used in lyric
    discovery selects its recognized span. It cannot add or replace any written text.
    """
    key = _lyrics_key(" ".join(words))
    best = _best_phrase_match(window, key, heard, margin)
    span = (
        best[1:]
        if best is not None
        else _nearby_utterance(window, heard, margin)
        if allow_utterance
        else None
    )
    if span is None or (window.heard_start is None and (best is None or best[0] < len(key) * 0.5)):
        return None, {}
    first, last = span
    phrase = replace(
        window,
        start=min(window.start, heard[first][1]) if best is not None else window.start,
        end=min(window.end, heard[last - 1][2] + margin),
        heard_start=window.heard_start if window.heard_start is not None else heard[first][1],
    )
    return phrase, _character_intervals(
        words, heard[first:last], window.first
    ) if best is not None else {}


def _best_phrase_match(
    window: ctc.Window,
    key: str,
    heard: Sequence[tuple[str, float, float]],
    margin: float,
) -> tuple[int, int, int] | None:
    keys = [_lyrics_key(word) for word, _, _ in heard]
    matches = [
        (support, first, last)
        for first, (_, start, end) in enumerate(heard)
        if (
            window.start - margin <= start
            or window.heard_start is not None
            and start <= window.heard_start < end
        )
        and start
        < (window.end if window.heard_start is None else min(window.end, window.start + 2 * margin))
        for last, support in _line_matches(key, keys, first)
        if heard[last - 1][1] < window.end and heard[last - 1][2] <= window.end + margin
    ]
    # Equal text support must keep the nearest occurrence, not the largest ASR index.
    entry = window.heard_start if window.heard_start is not None else window.start
    return max(
        matches,
        key=lambda match: (match[0], -abs(heard[match[1]][1] - entry)),
        default=None,
    )


def _nearby_utterance(
    window: ctc.Window,
    heard: Sequence[tuple[str, float, float]],
    margin: float,
) -> tuple[int, int] | None:
    starts = [
        index
        for index, (_, start, end) in enumerate(heard)
        if window.start - margin <= start < min(window.end, window.start + 2 * margin)
        and end <= window.end
    ]
    if not starts:
        return None
    first = min(
        starts, key=lambda index: abs(heard[index][1] - (window.heard_start or window.start))
    )
    last = first + 1
    while (
        last < len(heard)
        and heard[last][1] - heard[last - 1][2] <= margin
        and heard[last][2] <= window.end
    ):
        last += 1
    return first, last


def _character_intervals(
    words: Sequence[str],
    heard: Sequence[tuple[str, float, float]],
    first: int,
) -> dict[int, tuple[float, float]]:
    keys = [_lyrics_key(word) for word in words]
    written = [(char, first + index) for index, key in enumerate(keys) for char in key]
    spoken = [
        (
            char,
            (
                start + (end - start) * index / len(key),
                start + (end - start) * (index + 1) / len(key),
            ),
            (start, end),
        )
        for word, start, end in heard
        for key in [_lyrics_key(word)]
        for index, char in enumerate(key)
    ]
    intervals = _matched_positions(written, [char for char, _, _ in spoken])
    result: dict[int, tuple[float, float]] = {}
    for index, positions in intervals.items():
        precise = 2 * len(positions) > len(keys[index - first])
        spans = [
            part if precise else whole
            for position in positions
            for _, part, whole in [spoken[position]]
        ]
        result[index] = min(start for start, _ in spans), max(end for _, end in spans)
    for index, positions in intervals.items():
        if 2 * len(positions) <= len(keys[index - first]):
            start, end = result[index]
            result[index] = (
                max(start, result.get(index - 1, (start, start))[1]),
                min(end, result.get(index + 1, (end, end))[0]),
            )
            if result[index][1] <= result[index][0]:
                result[index] = (spoken[positions[0]][1][0], spoken[positions[-1]][1][1])
    return result


def _matched_positions(
    written: Sequence[tuple[str, int]],
    spoken: Sequence[str],
) -> dict[int, list[int]]:
    matches = SequenceMatcher(
        None, "".join(char for char, _ in written), "".join(spoken), autojunk=False
    ).get_matching_blocks()
    result: dict[int, list[int]] = {}
    for block in matches:
        for offset in range(block.size):
            index = written[block.a + offset][1]
            result.setdefault(index, []).append(block.b + offset)
    return result


def phrase_window(
    window: ctc.Window,
    phrase: ctc.Window | None,
    whole_start: float,
    last_heard: tuple[float, float] | None,
    margin: float,
) -> ctc.Window:
    """Combine independent phrase evidence without treating padded ASR as a voice entry.

    These bounds select phonetic cores only. Acoustic tail refinement still searches
    the full recording, including real vowels that continue beyond recognition.
    """
    entry = window.heard_start
    if entry is None:
        return window
    if (
        phrase is not None
        and phrase.heard_start is not None
        and window.start - margin <= phrase.heard_start < min(window.end, window.start + 2 * margin)
        and phrase.end > window.start
    ):
        return replace(
            window,
            start=min(window.start, phrase.start),
            end=min(window.end, phrase.end),
            heard_start=phrase.heard_start,
        )
    # A missing prefix must retain the catalogue entry. A supported last word can
    # nevertheless stop the alternative search borrowing the following instrumental break.
    if (
        last_heard is not None
        and abs(whole_start - entry) > margin
        and window.start <= last_heard[0] <= last_heard[1] <= window.end
        and entry <= last_heard[1]
    ):
        return replace(window, end=min(window.end, last_heard[1] + margin))
    return window


def _key(text: str) -> str:
    return "".join(character for character in text.lower() if character.isalnum())


def _matching_blocks(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[ctc.AlignedWord] | None = None,
) -> list[difflib.Match]:
    keys = [_key(word) for word in words]
    heard_keys = [item[0] for item in heard]
    if whole is None:
        return difflib.SequenceMatcher(a=keys, b=heard_keys, autojunk=False).get_matching_blocks()
    # Match coverage first; bounded timing proximity only disambiguates equal-coverage repeats.
    proximity = 1 / (min(len(words), len(heard)) + 1)
    scores = _matching_scores(words, heard, whole, keys, heard_keys, proximity)
    blocks: list[difflib.Match] = []
    i, j = 0, 0
    while i < len(words) and j < len(heard):
        if keys[i] == heard_keys[j] and scores[i, j] == (
            scores[i + 1, j + 1] + 1 + proximity / (1 + abs(whole[i].start - heard[j][1]))
        ):
            if (
                blocks
                and blocks[-1].a + blocks[-1].size == i
                and blocks[-1].b + blocks[-1].size == j
            ):
                previous = blocks[-1]
                blocks[-1] = difflib.Match(previous.a, previous.b, previous.size + 1)
            else:
                blocks.append(difflib.Match(i, j, 1))
            i, j = i + 1, j + 1
        elif scores[i + 1, j] >= scores[i, j + 1]:
            i += 1
        else:
            j += 1
    return blocks


def _matching_scores(
    words: list[str],
    heard: list[tuple[str, float, float]],
    whole: Sequence[ctc.AlignedWord],
    keys: list[str],
    heard_keys: list[str],
    proximity: float,
) -> np.ndarray:
    scores = np.zeros((len(words) + 1, len(heard) + 1))
    for i in range(len(words) - 1, -1, -1):
        for j in range(len(heard) - 1, -1, -1):
            match = (
                scores[i + 1, j + 1] + 1 + proximity / (1 + abs(whole[i].start - heard[j][1]))
                if keys[i] == heard_keys[j]
                else 0.0
            )
            scores[i, j] = max(scores[i + 1, j], scores[i, j + 1], match)
    return scores
