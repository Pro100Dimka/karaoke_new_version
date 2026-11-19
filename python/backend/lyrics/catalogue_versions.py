from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from difflib import SequenceMatcher

from backend.lyrics.ports import LyricsCandidate
from backend.text_normalization import clean_lyrics

type _WordKey = Callable[[str], str]
type _LineMatches = Callable[[str, list[str], int], Iterator[tuple[int, int]]]
type _LinePath = tuple[tuple[int, int, int], ...]
type _State = tuple[int, _LinePath]


def corroborated_versions(
    candidates: Sequence[LyricsCandidate],
    transcripts: Sequence[str],
    key: _WordKey,
    matches: _LineMatches,
) -> Sequence[LyricsCandidate]:
    """Confirm nearby versions without discarding complete lines that recognition missed."""
    heard = [
        words
        for transcript in transcripts
        if len(words := _words(transcript, key)) >= 12
        and len({word for word in words if len(word) >= 3}) >= 8
    ]
    if len(heard) < 2 or len(candidates) < 2:
        return candidates
    expected = {item: _words(item.lyrics, key) for item in candidates}
    coverage = {
        item: [_ordered_coverage(words, view) for view in heard] for item, words in expected.items()
    }
    return [
        item
        for item in candidates
        if not any(
            len(expected[other]) <= len(expected[item])
            and all(
                left > right for left, right in zip(coverage[other], coverage[item], strict=True)
            )
            and _confirmed_counterparts(item.lyrics, expected[other], heard, key, matches)
            for other in candidates
        )
    ]


def _words(text: str, key: _WordKey) -> list[str]:
    return [value for word in clean_lyrics(text, "Auto").split() if (value := key(word))]


def _ordered_coverage(expected: Sequence[str], heard: Sequence[str]) -> int:
    """Count the longest ordered match without greedily assigning a repeated chorus."""
    row = [0] * (len(heard) + 1)
    for word in expected:
        previous, row = row, [0]
        for index, actual in enumerate(heard):
            row.append(previous[index] + 1 if word == actual else max(previous[index + 1], row[-1]))
    return row[-1]


def _confirmed_counterparts(
    original: str,
    replacement: list[str],
    heard: Sequence[list[str]],
    key: _WordKey,
    matches: _LineMatches,
) -> bool:
    lines = [
        words
        for line in clean_lyrics(original, "Auto").splitlines()
        if (words := _words(line, key))
    ]
    path = _preserved_lines(lines, replacement, matches)
    return path is not None and any(
        _positive_counterpart(lines[index], replacement[first:last], heard, matches)
        for index, first, last in path
    )


def _preserved_lines(
    lines: Sequence[list[str]], target: list[str], matches: _LineMatches
) -> _LinePath | None:
    """Every best supported ordered mapping must retain every original line occurrence."""
    states: dict[int, _State] = {0: (0, ())}
    cache: dict[str, tuple[tuple[int, int, int], ...]] = {}
    for index, line in enumerate(lines):
        key = "".join(line)
        if key not in cache:
            cache[key] = tuple(
                (first, last, support)
                for first in range(len(target))
                for last, support in matches(key, target, first)
            )
        prefixes = _best_prefixes(states, len(target))
        following = dict(states)
        for first, last, support in cache[key]:
            score, path = prefixes[first]
            candidate = (score + support, (*path, (index, first, last)))
            if last not in following or _rank(candidate) > _rank(following[last]):
                following[last] = candidate
        states = following
    _, path = max(states.values(), key=_rank)
    return path if len(path) == len(lines) else None


def _best_prefixes(states: dict[int, _State], size: int) -> list[_State]:
    best: _State = (0, ())
    prefixes = []
    for position in range(size + 1):
        if position in states and _rank(states[position]) > _rank(best):
            best = states[position]
        prefixes.append(best)
    return prefixes


def _rank(state: _State) -> tuple[int, int]:
    # A tied path that omits a line is enough to make whole-version replacement uncertain.
    return state[0], -len(state[1])


def _positive_counterpart(
    original: list[str],
    replacement: list[str],
    heard: Sequence[list[str]],
    matches: _LineMatches,
) -> bool:
    distinct = set(replacement) - set(original)
    return bool(distinct) and all(
        _view_supports_counterpart(original, replacement, distinct, view, matches) for view in heard
    )


def _view_supports_counterpart(
    original: list[str],
    replacement: list[str],
    distinct: set[str],
    heard: list[str],
    matches: _LineMatches,
) -> bool:
    found = [
        (support, first, last)
        for first in range(len(heard))
        for last, support in matches("".join(replacement), heard, first)
    ]
    if not found:
        return False
    best = max(support for support, _, _ in found)
    return all(
        bool(distinct.intersection(heard[first:last]))
        and support > _same_span_support(original, heard[first:last])
        for support, first, last in found
        if support == best
    )


def _same_span_support(expected: list[str], actual: list[str]) -> int:
    left, right = "".join(expected), "".join(actual)
    matched = sum(
        block.size
        for block in SequenceMatcher(None, left, right, autojunk=False).get_matching_blocks()
    )
    return 2 * matched - max(len(left), len(right))
