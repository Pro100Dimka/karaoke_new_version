from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from dataclasses import replace
from difflib import SequenceMatcher
from statistics import median

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


def reconcile_timed_overlaps(
    candidate: LyricsCandidate,
    alternatives: Sequence[LyricsCandidate],
    transcripts: Sequence[str],
    key: _WordKey,
) -> LyricsCandidate:
    """Reconcile a copied full cue with a positively supported shorter catalogue prefix."""
    lines, hints = candidate.lyrics.splitlines(), candidate.timing_hints
    words = [_words(line, key) for line in lines]
    if not transcripts or not all(words) or words != [_words(hint.text, key) for hint in hints]:
        return candidate
    heard = [_words(text, key) for text in transcripts]
    changes: dict[int, str] = {}
    for index in range(1, len(words) - 1):
        full, fragment, following = words[index - 1 : index + 2]
        if len(set(fragment)) < 3 or words.count(fragment) != 1 or following == fragment:
            continue
        spans = [
            hints[i + 1].start - hints[i].start
            for i in range(len(words) - 1)
            if words[i] == words[i + 1] == full and hints[i + 1].start > hints[i].start
        ]
        typical = median(spans) if spans else 0
        actual_span = hints[index].start - hints[index - 1].start
        if (
            not 0 < actual_span < typical
            or sum(abs(span / typical - 1) <= 0.15 for span in spans) < 3
        ):
            continue
        prefixes = set()
        for other in alternatives:
            raw = [line for line in other.lyrics.splitlines() if line.strip()]
            variants = [_words(line, key) for line in raw]
            if variants.count(fragment) != 1:
                continue
            at = variants.index(fragment)
            if not 0 < at < len(variants) - 1 or variants[at + 1] != following:
                continue
            prefix = variants[at - 1]
            if (
                len(prefix) >= 3
                and prefix == full[: len(prefix)]
                and full[len(prefix) : len(prefix) + len(fragment)] == fragment
                and abs(actual_span / typical - len(prefix) / len(full)) <= 0.05
            ):
                prefixes.add(tuple(prefix))
        if len(prefixes) != 1:
            continue
        replacement = " ".join(
            clean_lyrics(lines[index - 1], "Auto").split()[: len(next(iter(prefixes)))]
        )
        chain = _words(replacement, key)[-3:] + fragment + following[:3]
        original = full + fragment + following[:3]
        counts = [
            sum(view[i : i + len(chain)] == chain for i in range(len(view))) for view in heard
        ]
        if max(counts, default=0) != 1 or any(
            view[i : i + len(original)] == original for view in heard for i in range(len(view))
        ):
            continue
        changes[index - 1] = replacement
    return (
        replace(
            candidate,
            lyrics="\n".join(changes.get(i, line) for i, line in enumerate(lines)),
            timing_hints=tuple(
                replace(hint, text=changes.get(i, hint.text)) for i, hint in enumerate(hints)
            ),
        )
        if changes
        else candidate
    )


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
