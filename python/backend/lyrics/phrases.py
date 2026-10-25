from __future__ import annotations

import math
import threading
from collections import Counter
from difflib import SequenceMatcher
from typing import Sequence

from backend.domain_errors import ConflictError


def _lyrics_key(text: str) -> str:
    return "".join(char for char in text.casefold() if char.isalpha())


def _complete_repeats(lyrics: str, transcript: str, cancel: threading.Event) -> str:
    """Recover performed catalogue phrases without replacing good words with ASR spelling.

    Phrase selection scores matching characters against recognition errors. A nonsequential
    phrase costs log2(catalogue size), so repeats need evidence instead of a duration rule.
    Keep every original line when ASR misses quiet singing. Only surplus recognized occurrences
    can add repeats; conflicting order alone cannot invent another catalogue line.
    """
    lines = [line for line in lyrics.splitlines() if _lyrics_key(line)]
    keys = list(dict.fromkeys(_lyrics_key(line) for line in lines))
    if not keys or not transcript:
        return lyrics
    original = [keys.index(_lyrics_key(line)) for line in lines]
    heard = [_lyrics_key(word) for word in transcript.split() if _lyrics_key(word)]
    matches = _performed_lines(keys, heard, set(zip(original, original[1:])), cancel)
    # A catalogue's standalone prefix can steal the last reply ("дозволиш" / "дозволиш мені").
    # Retain the full heard suffix when it supplies repeated complete answers.
    stop, tails = len(matches), _tails(lyrics)
    while stop and any(
        tail.startswith(key) and tail != key
        for key in [keys[matches[stop - 1][0]]]
        for tail in tails
    ):
        stop -= 1
    after = matches[stop - 1][2] if stop else 0
    if stop < len(matches) and _repeat_ending(lyrics, heard[after:], cancel) != lyrics:
        matches = matches[:stop]
    performed = tuple(index for index, _, _ in matches)
    merged = _merge_lines(original, performed, keys)
    written = {_lyrics_key(line): line for line in reversed(lines)}
    completed = (
        lyrics
        if len(merged) == len(original)
        else "\n".join(written[keys[index]] for index in merged)
    )
    return _repeat_ending(completed, heard[matches[-1][2] :] if matches else [], cancel)


def _repeat_ending(lyrics: str, heard: list[str], cancel: threading.Event) -> str:
    """Recover repeated outro tails without making the singer repeat their unsung prefixes."""
    if not heard:
        return lyrics
    written = _tails(lyrics)
    keys = list(written)
    if not keys:
        return lyrics
    matches = _performed_lines(keys, heard, {(i, i) for i in range(len(keys))}, cancel)
    counts = Counter(index for index, _, _ in matches)
    tails = [written[keys[index]] for index, _, _ in matches if counts[index] >= 2]
    return "\n".join([lyrics, *tails]) if tails else lyrics


def _tails(lyrics: str) -> dict[str, str]:
    return {
        _lyrics_key(tail): tail
        for line in lyrics.splitlines()
        for words in [line.split()]
        for size in range(2, len(words) // 2 + 1)
        for tail in [" ".join(words[-size:])]
        if len(_lyrics_key(tail)) >= 8
    }


_LinePath = tuple[float, tuple[tuple[int, int, int], ...]]


def _line_variants(keys: Sequence[str]) -> set[tuple[int, int]]:
    return {
        (a, b)
        for a, left in enumerate(keys)
        for b, right in enumerate(keys)
        if left == right or (right in left and 2 * len(right) > len(left))
    }


def _variant_transitions(
    keys: Sequence[str], following: set[tuple[int, int]]
) -> set[tuple[int, int]]:
    variants = _line_variants(keys)
    # Prefix/adlib variants compete on character evidence with the same transition prior.
    return {
        (before, after)
        for previous, line in following
        for before in range(len(keys))
        if (previous, before) in variants or (before, previous) in variants
        for after in range(len(keys))
        if (line, after) in variants or (after, line) in variants
    }


def performed_phrases(
    lyrics: str,
    words: Sequence[str],
    cancel: threading.Event,
) -> tuple[tuple[str, int, int], ...]:
    """Catalogue phrase and the independent ASR word span that supports each occurrence."""
    lines = [line for line in lyrics.splitlines() if _lyrics_key(line)]
    keys = list(dict.fromkeys(_lyrics_key(line) for line in lines))
    if not keys or not words:
        return ()
    original = [keys.index(_lyrics_key(line)) for line in lines]
    matches = _performed_lines(
        keys,
        [_lyrics_key(word) for word in words],
        set(zip(original, original[1:])),
        cancel,
    )
    return tuple((lines[original.index(index)], first, last) for index, first, last in matches)


def _performed_lines(
    keys: list[str],
    heard: list[str],
    following: set[tuple[int, int]],
    cancel: threading.Event,
) -> tuple[tuple[int, int, int], ...]:
    following = _variant_transitions(keys, following)
    states: list[dict[int, _LinePath]] = [{} for _ in range(len(heard) + 1)]
    states[0][-1] = (0.0, ())
    choice_cost = math.log2(len(keys) + 1)
    empty: _LinePath = (-math.inf, ())
    for start in range(len(heard)):
        if cancel.is_set():
            raise ConflictError("JobCancelled", "Lyrics coverage check was cancelled")
        row = states[start]
        best = max(row.values(), key=lambda item: item[0])
        for last, (score, path) in row.items():
            # ASR may miss quiet words or invent unrelated text. Leaving it unmatched must
            # not reward forcing a weakly similar catalogue phrase into the performance.
            skipped = (score, path)
            if skipped[0] > states[start + 1].get(last, empty)[0]:
                states[start + 1][last] = skipped
        for index, key in enumerate(keys):
            sequential = max(
                (value for last, value in row.items() if (last, index) in following),
                key=lambda item: item[0],
                default=empty,
            )
            score, path = max(
                ((best[0] - choice_cost, best[1]), sequential),
                key=lambda item: item[0],
            )
            for end, support in _line_matches(key, heard, start):
                candidate = (score + support, (*path, (index, start, end)))
                if candidate[0] > states[end].get(index, empty)[0]:
                    states[end][index] = candidate
    return max(states[-1].values(), key=lambda item: item[0])[1]


def _line_matches(key: str, heard: list[str], start: int) -> list[tuple[int, int]]:
    matches: list[tuple[int, int]] = []
    joined = ""
    for end in range(start, len(heard)):
        joined += heard[end]
        # Beyond twice the phrase length even a complete character match cannot score positively.
        if len(joined) > 2 * len(key):
            break
        if 2 * len(joined) <= len(key):
            continue
        matcher = SequenceMatcher(None, key, joined, autojunk=False)
        # Multiset overlap is an upper bound: prune only scores that cannot become positive.
        if matcher.quick_ratio() <= max(len(key), len(joined)) / (len(key) + len(joined)):
            continue
        blocks = [block for block in matcher.get_matching_blocks() if block.size]
        if not blocks or blocks[0].b >= len(heard[start]):
            continue
        if blocks[-1].b + blocks[-1].size <= len(joined) - len(heard[end]):
            continue
        matched = sum(block.size for block in blocks)
        support = 2 * matched - max(len(key), len(joined))
        if support > 0:
            matches.append((end + 1, support))
    return matches


def _merge_lines(original: list[int], performed: tuple[int, ...], keys: list[str]) -> list[int]:
    extra = Counter(performed) - Counter(original)
    merged: list[int] = []
    first = heard_first = 0
    for i, j in (*_line_anchors(original, performed, keys), (len(original), len(performed))):
        added = []
        for index in performed[heard_first:j]:
            if extra[index] > 0:
                added.append(index)
                extra[index] -= 1
        skipped = original[first:i]
        # Consecutive recognized repeats belong together at their matched occurrence;
        # missed catalogue lines before that occurrence must not split the repeats.
        adjacent = i < len(original) and added and added[-1] == original[i]
        merged.extend((*skipped, *added) if adjacent else (*added, *skipped))
        if i < len(original):
            merged.append(original[i])
        first, heard_first = i + 1, j + 1
    return merged


def _line_anchors(
    original: list[int], performed: tuple[int, ...], keys: list[str]
) -> list[tuple[int, int]]:
    counts = Counter(original)
    equivalent = _line_variants(keys)
    lengths = [[0.0] * (len(performed) + 1) for _ in range(len(original) + 1)]
    for i in range(len(original) - 1, -1, -1):
        for j in range(len(performed) - 1, -1, -1):
            lengths[i][j] = (
                lengths[i + 1][j + 1] + 1 / counts[original[i]]
                if (original[i], performed[j]) in equivalent
                else max(lengths[i + 1][j], lengths[i][j + 1])
            )
    anchors: list[tuple[int, int]] = []
    i = j = 0
    while i < len(original) and j < len(performed):
        if (original[i], performed[j]) in equivalent:
            anchors.append((i, j))
            i, j = i + 1, j + 1
        elif lengths[i + 1][j] > lengths[i][j + 1]:
            i += 1
        else:
            j += 1
    return anchors
