from __future__ import annotations

import math
import threading
from collections import Counter
from collections.abc import Callable, Iterable, Iterator
from difflib import Match, SequenceMatcher
from functools import cache
from typing import Sequence

from backend.domain_errors import ConflictError
from backend.lyrics.catalogue_versions import corroborated_versions
from backend.lyrics.ports import LyricsCandidate
from backend.text_normalization import clean_lyrics


_LONG_PHRASE_LENGTH = 48


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
    tails = _tails(lyrics)
    matches = _repeat_entries(keys, heard, set(zip(original, original[1:])), tails, cancel)
    matches = _trim_prefix_entries(lyrics, keys, heard, tails, matches, cancel)
    performed = tuple(index for index, _, _ in matches)
    written = {_lyrics_key(line): line for line in reversed(lines)}
    parts = [[_lyrics_key(word) for word in written[key].split()] for key in keys]
    prefixes = {
        (a, b)
        for a, full in enumerate(parts)
        for b, short in enumerate(parts)
        if 3 <= len(short) < len(full) and full[: len(short)] == short
    }
    merged = _merge_lines(original, performed, keys, prefixes=prefixes)
    completed = (
        lyrics
        if len(merged) == len(original)
        else "\n".join(written[keys[index]] for index in merged)
    )
    return _repeat_ending(completed, heard[matches[-1][2] :] if matches else [], cancel)


def _trim_prefix_entries(
    lyrics: str,
    keys: list[str],
    heard: list[str],
    tails: dict[str, str],
    matches: tuple[tuple[int, int, int], ...],
    cancel: threading.Event,
) -> tuple[tuple[int, int, int], ...]:
    # A standalone prefix can steal the last reply. Keep a suffix with repeated complete answers.
    stop = len(matches)
    while stop:
        key = keys[matches[stop - 1][0]]
        if not any(tail.startswith(key) and tail != key for tail in tails):
            break
        stop -= 1
    after = matches[stop - 1][2] if stop else 0
    if stop < len(matches) and _repeat_ending(lyrics, heard[after:], cancel) != lyrics:
        return matches[:stop]
    return matches


def _repeat_entries(
    keys: list[str],
    heard: list[str],
    following: set[tuple[int, int]],
    tails: dict[str, str],
    cancel: threading.Event,
) -> tuple[tuple[int, int, int], ...]:
    choices = [*keys, *(key for key in tails if key not in keys)]
    if choices == keys:
        return _performed_lines(keys, heard, following, cancel)

    @cache
    def compare(key: str, start: int) -> tuple[tuple[int, int], ...]:
        return tuple(_line_matches(key, heard, start))

    matches = _performed_lines(choices, heard, following, cancel, compare=compare)
    tail_counts = Counter(index for index, _, _ in matches if index >= len(keys))
    # One incomplete ASR line cannot establish a chopped outro. Require the same
    # independently matched tail twice before letting tails displace full phrases.
    return (
        tuple(match for match in matches if match[0] < len(keys))
        if any(count >= 2 for count in tail_counts.values())
        else _performed_lines(keys, heard, following, cancel, compare=compare)
    )


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
        if left == right
        or (right in left and 2 * len(right) > len(left))
        or _short_insertion_variant(left, right)
    }


def _short_insertion_variant(left: str, right: str) -> bool:
    short, long = sorted((left, right), key=len)
    gap = len(long) - len(short)
    if len(short) < 24 or not 0 < gap <= 3:
        return False
    prefix = next((i for i, pair in enumerate(zip(short, long)) if pair[0] != pair[1]), len(short))
    return short[prefix:] == long[prefix + gap :]


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
    *,
    compare: Callable[[str, int], Iterable[tuple[int, int]]] | None = None,
) -> tuple[tuple[int, int, int], ...]:
    match_at = compare or (lambda key, start: _line_matches(key, heard, start))
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
            for end, support in match_at(key, start):
                candidate = (score + support, (*path, (index, start, end)))
                if candidate[0] > states[end].get(index, empty)[0]:
                    states[end][index] = candidate
    return max(states[-1].values(), key=lambda item: item[0])[1]


class _LongPhraseMatcher(SequenceMatcher[str]):
    """Find exact matching blocks without the Python character-pair loop on long phrases."""

    a: str
    b: str

    def __init__(self, written: str, heard: str) -> None:
        super().__init__(None, written, heard, autojunk=False)

    def find_longest_match(
        self, alo: int = 0, ahi: int | None = None, blo: int = 0, bhi: int | None = None
    ) -> Match:
        a, b = self.a, self.b
        ahi = len(a) if ahi is None else ahi
        bhi = len(b) if bhi is None else bhi
        limit = min(ahi - alo, bhi - blo)
        if limit < _LONG_PHRASE_LENGTH:
            return super().find_longest_match(alo, ahi, blo, bhi)
        best = Match(alo, blo, 0)
        low, high = 1, limit
        # A shared substring of length n guarantees that each shorter length is
        # possible. Scanning starts in order retains difflib's tie breaking.
        while low <= high:
            size = (low + high) // 2
            for first in range(alo, ahi - size + 1):
                second = b.find(a[first : first + size], blo, bhi)
                if second >= 0:
                    best = Match(first, second, size)
                    low = size + 1
                    break
            else:
                high = size - 1
        return best


def _line_matches(key: str, heard: list[str], start: int) -> Iterator[tuple[int, int]]:
    joined = ""
    remaining = Counter(key)
    shared = 0
    for end in range(start, len(heard)):
        word = heard[end]
        joined += word
        # Beyond twice the phrase length even a complete character match cannot score positively.
        if len(joined) > 2 * len(key):
            break
        for char in word:
            count = remaining.get(char, 0)
            if count:
                remaining[char] = count - 1
                shared += 1
        # Carry the same multiset upper bound forward as each word extends the window.
        # Construct the sequence matcher only when a positive score is still possible.
        if 2 * shared <= max(len(key), len(joined)):
            continue
        matcher = (
            _LongPhraseMatcher(key, joined)
            if min(len(key), len(joined)) >= _LONG_PHRASE_LENGTH
            else SequenceMatcher(None, key, joined, autojunk=False)
        )
        blocks = [block for block in matcher.get_matching_blocks() if block.size]
        if not blocks or blocks[0].b >= len(heard[start]):
            continue
        if blocks[-1].b + blocks[-1].size <= len(joined) - len(heard[end]):
            continue
        matched = sum(block.size for block in blocks)
        support = 2 * matched - max(len(key), len(joined))
        if support > 0:
            yield end + 1, support


def _merge_lines(
    original: list[int],
    performed: tuple[int, ...],
    keys: list[str],
    *,
    prefixes: set[tuple[int, int]] | None = None,
) -> list[int]:
    extra = Counter(performed) - Counter(original)
    merged: list[int] = []
    first = heard_first = 0
    for i, j in (
        *_line_anchors(original, performed, keys, prefixes),
        (len(original), len(performed)),
    ):
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
    original: list[int],
    performed: tuple[int, ...],
    keys: list[str],
    prefixes: set[tuple[int, int]] | None = None,
) -> list[tuple[int, int]]:
    counts = Counter(original)
    equivalent = _line_variants(keys)
    prefixes = (prefixes or set()) - equivalent
    pairs = equivalent | prefixes
    lengths = [[(0.0, 0)] * (len(performed) + 1) for _ in range(len(original) + 1)]

    def matched(i: int, j: int) -> tuple[float, int]:
        pair = (original[i], performed[j])
        if pair not in pairs:
            return -math.inf, 0
        score, exact = lengths[i + 1][j + 1]
        return score + 1 / counts[original[i]], exact + int(bool(prefixes) and pair in equivalent)

    for i in range(len(original) - 1, -1, -1):
        for j in range(len(performed) - 1, -1, -1):
            match = matched(i, j)
            # A partial cue can explain a missed full line, but cannot consume a later
            # complete occurrence and hide a genuine surplus prefix between them.
            lengths[i][j] = (
                max(match, lengths[i + 1][j], lengths[i][j + 1])
                if prefixes or match[0] == -math.inf
                else match
            )
    return _trace_line_anchors(original, performed, pairs, lengths, matched if prefixes else None)


def _trace_line_anchors(
    original: list[int],
    performed: tuple[int, ...],
    pairs: set[tuple[int, int]],
    lengths: list[list[tuple[float, int]]],
    matched: Callable[[int, int], tuple[float, int]] | None,
) -> list[tuple[int, int]]:
    anchors: list[tuple[int, int]] = []
    i = j = 0
    while i < len(original) and j < len(performed):
        if (original[i], performed[j]) in pairs and (
            matched is None or lengths[i][j] == matched(i, j)
        ):
            anchors.append((i, j))
            i, j = i + 1, j + 1
        elif lengths[i + 1][j] > lengths[i][j + 1]:
            i += 1
        else:
            j += 1
    return anchors


def _lyrics_match(expected: str, actual: str) -> bool:
    left = expected.casefold().split()
    right = actual.casefold().split()
    return SequenceMatcher(None, left, right, autojunk=False).ratio() >= 0.90


def _same_vocabulary(expected: str, actual: str) -> bool:
    vocabularies = [
        " ".join(sorted({_lyrics_key(word) for word in text.split() if _lyrics_key(word)}))
        for text in (expected, actual)
    ]
    return _lyrics_match(*vocabularies)


def _catalog_matches_performance(lyrics: str, transcripts: Sequence[str]) -> bool:
    """Reject unrelated catalogues only when recognition contains enough distinct words.

    Reusable adjacent-word anchors tolerate missed verses and additional sung repeats.
    A weak recognition result cannot establish that a catalogue is wrong.
    """
    expected = [_lyrics_key(word) for word in clean_lyrics(lyrics, "Auto").split()]
    pairs = set(zip(expected, expected[1:]))
    checked = False
    for transcript in transcripts:
        heard = [_lyrics_key(word) for word in transcript.split() if _lyrics_key(word)]
        if len(heard) < 12 or len({word for word in heard if len(word) >= 3}) < 8:
            continue
        checked = True
        matched: set[int] = set()
        for index, pair in enumerate(zip(heard, heard[1:])):
            if pair in pairs:
                matched.update((index, index + 1))
        if len(matched) >= max(4, len(heard) * 0.2):
            return True
    return not checked


def _best_catalog_version(
    candidates: Sequence[LyricsCandidate],
    distances: dict[LyricsCandidate, float],
    transcripts: Sequence[str],
) -> LyricsCandidate:
    candidates = corroborated_versions(candidates, transcripts, _lyrics_key, _line_matches)
    coverage = {item: _performed_coverage(item.lyrics, transcripts) for item in candidates}
    best = max(coverage.values())
    # A few accidental matches cannot distinguish versions more reliably than the
    # recognizer's own unmatched words. Within that uncertainty, use recording duration.
    uncertainty = sum(len(heard.split()) for heard in transcripts) - best
    vocabularies = [{_lyrics_key(word) for word in heard.split()} for heard in transcripts]
    unexplained = dict.fromkeys(candidates, 0)
    for item in candidates:
        for line in clean_lyrics(item.lyrics, "Auto").splitlines():
            words = [_lyrics_key(word) for word in line.split()]
            if len(words) >= 3:
                # Missing repeats or one missed adlib do not prove another recording.
                # Entire lines of unfamiliar words are different evidence.
                unexplained[item] += sum(
                    len(words)
                    for vocabulary in vocabularies
                    if sum(word not in vocabulary for word in words) * 2 > len(words)
                )
    supported = [item for item in candidates if best - coverage[item] <= uncertainty]
    least_unexplained = min(unexplained[item] for item in supported)
    return min(
        (item for item in supported if unexplained[item] - least_unexplained <= uncertainty),
        key=lambda item: (
            distances[item],
            -len(item.lyrics.split()),
        ),
    )


def _performed_coverage(lyrics: str, transcripts: Sequence[str]) -> int:
    expected = [_lyrics_key(word) for word in clean_lyrics(lyrics, "Auto").split()]
    return sum(
        block.size
        for heard in transcripts
        for block in SequenceMatcher(
            None, expected, [_lyrics_key(word) for word in heard.split()], autojunk=False
        ).get_matching_blocks()
    )


def _timed_catalog_version(
    eligible: Sequence[LyricsCandidate],
    candidate: LyricsCandidate,
    distances: dict[LyricsCandidate, float],
) -> LyricsCandidate | None:
    return next(
        (
            item
            for item in eligible
            if distances[item] == distances[candidate]
            and item.timing_hints
            and _lyrics_match(candidate.lyrics, item.lyrics)
        ),
        None,
    )


def _catalog_distances(
    candidates: Sequence[LyricsCandidate],
    duration: float | None,
) -> dict[LyricsCandidate, float]:
    return {
        item: abs(duration - item.duration)
        if duration is not None and item.duration is not None
        else (math.inf if duration is not None else 0.0)
        for item in candidates
    }
