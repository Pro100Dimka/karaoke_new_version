from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import replace
import difflib
from difflib import SequenceMatcher

import numpy as np
import torch

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
    key, keys = _lyrics_key(" ".join(words)), [_lyrics_key(word) for word, _, _ in heard]
    matches = [
        (support, first, last)
        for first, (_, start, _) in enumerate(heard)
        if window.start - margin <= start < min(window.end, window.start + 2 * margin)
        for last, support in _line_matches(key, keys, first)
        if heard[last - 1][1] < window.end and heard[last - 1][2] <= window.end + margin
    ]
    span = (
        max(matches)[1:]
        if matches
        else _nearby_utterance(window, heard, margin)
        if allow_utterance
        else None
    )
    if window.heard_start is None or span is None:
        return None, {}
    first, last = span
    phrase = replace(
        window,
        start=min(window.start, heard[first][1]) if matches else window.start,
        end=min(window.end, heard[last - 1][2] + margin),
    )
    return phrase, _character_intervals(words, heard[first:last], window.first) if matches else {}


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


def with_word_guidance(
    words: list[ctc.AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    windows: Sequence[ctc.Window],
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    margin: float,
    *,
    recognized: Sequence[tuple[str, float, float]] = (),
) -> list[ctc.AlignedWord]:
    result = list(words)
    for window in windows:
        phrase, local = recognized_phrase(
            window,
            [word.text for word in words[window.first : window.last]],
            recognized,
            margin,
            allow_utterance=window.first - 1 in heard and window.last in heard,
        )
        timings = local | dict(heard)
        first, last = max(0, window.first - 1), min(len(words), window.last + 1)
        options = [[word] for word in result[first:last]]
        alternatives = _recognized_cores(
            words, scores, frame_seconds, window, timings, voiced, margin
        )
        if phrase is not None:
            alternatives += _unrecognized_runs(
                words,
                scores,
                frame_seconds,
                phrase,
                timings,
                voiced,
            )
        for index, candidate, interval in alternatives:
            options[index - first].append(candidate)
            timings[index] = interval
        result[first:last] = _select_sequence(result[first:last], options, timings, first, voiced)
    return result


def _recognized_cores(
    words: Sequence[ctc.AlignedWord],
    scores: torch.Tensor,
    frame_seconds: float,
    window: ctc.Window,
    heard: Mapping[int, tuple[float, float]],
    voiced: np.ndarray,
    margin: float,
) -> list[tuple[int, ctc.AlignedWord, tuple[float, float]]]:
    return [
        (index, candidate, interval)
        for index in range(window.first, window.last)
        if (interval := heard.get(index)) is not None
        for candidate in _candidates(
            words[index], scores, frame_seconds, window, interval, voiced, margin
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
            candidates = ctc._align_window(
                scores,
                frame_seconds,
                [w.text for w in words[first:index]],
                ctc.Window(first, index, start, end),
            )
            if first == window.first:
                candidates = _settle_unrecognized_entry(candidates, window, frame_seconds)
            for offset, candidate in enumerate(candidates):
                word = words[first + offset]
                if word.score <= candidate.score + ctc._PREFERENCE and ctc._implausible(
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
) -> list[ctc.AlignedWord]:
    first, last = interval
    miss = abs(first - word.start)
    if miss <= ctc._HEARD_DISAGREEMENT_SECONDS:
        return []
    return [
        candidate
        for candidate in _core_candidates(
            word,
            scores,
            frame_seconds,
            window,
            interval,
            margin,
        )
        if miss - abs(first - candidate.start) > ctc._HEARD_DISAGREEMENT_SECONDS
        and word.score <= candidate.score + ctc._PREFERENCE
        and ctc._implausible([candidate], voiced) <= ctc._implausible([word], voiced)
    ]


def _core_candidates(
    word: ctc.AlignedWord,
    scores: torch.Tensor,
    frame_seconds: float,
    window: ctc.Window,
    interval: tuple[float, float],
    margin: float,
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
    if start < end:
        # A zero-confidence alternative cannot defeat strong phonetic evidence. A
        # misplaced core may move in full; acoustic refinement still owns the tail.
        candidates.extend(ctc._evenly([word.text], start, end))
    return candidates


def _select_sequence(
    original: list[ctc.AlignedWord],
    options: Sequence[Sequence[ctc.AlignedWord]],
    heard: Mapping[int, tuple[float, float]],
    first: int,
    voiced: np.ndarray,
) -> list[ctc.AlignedWord]:
    """Choose word cores jointly; an improvement cannot crush or reverse a neighbour."""
    baseline = ctc.ordered(original)
    states: list[tuple[float, float, list[ctc.AlignedWord]]] = [(0.0, 0.0, [])]
    for index, choices in enumerate(options):
        following: list[tuple[float, float, list[ctc.AlignedWord]]] = []
        interval = heard.get(first + index)
        for word in choices:
            distance = (
                (
                    max(0.0, interval[0] - word.start, word.start - interval[1])
                    + max(0.0, interval[0] - word.end, word.end - interval[1])
                )
                if interval
                else 0.0
            )
            paths = [
                (cost + distance, confidence - word.score, [*path, word])
                for cost, confidence, path in states
                if not path or _compatible(path[-1], word, baseline[index - 1], voiced)
            ]
            if paths:
                following.append(min(paths, key=lambda item: item[:2]))
        states = following
    return min(states, key=lambda item: item[:2])[2] if states else original


def _compatible(
    left: ctc.AlignedWord,
    right: ctc.AlignedWord,
    original: ctc.AlignedWord,
    voiced: np.ndarray,
) -> bool:
    return left.start < right.start and ctc._implausible(
        [ctc.ordered([left, right])[0]], voiced
    ) <= ctc._implausible([original], voiced)


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
    # Soft CTC timing disambiguates repeated choruses when ASR misses an occurrence.
    scores = np.zeros((len(words) + 1, len(heard) + 1))
    for i in range(len(words) - 1, -1, -1):
        for j in range(len(heard) - 1, -1, -1):
            match = (
                scores[i + 1, j + 1] + 1 / (1 + abs(whole[i].start - heard[j][1]))
                if keys[i] == heard_keys[j]
                else 0.0
            )
            scores[i, j] = max(scores[i + 1, j], scores[i, j + 1], match)
    blocks: list[difflib.Match] = []
    i, j = 0, 0
    while i < len(words) and j < len(heard):
        if keys[i] == heard_keys[j] and scores[i, j] == (
            scores[i + 1, j + 1] + 1 / (1 + abs(whole[i].start - heard[j][1]))
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
