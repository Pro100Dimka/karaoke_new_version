from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
import unicodedata

from backend.ai_worker.ctc_domain import _CRAMMED_WORD_SECONDS
from backend.ai_worker.asr_views import (
    AsrEvidence as AsrEvidence,
    AsrView,
    TimedToken as TimedToken,
    display_tokens,
    read_views,
    token_key,
)

_MARGIN = 0.6
_MINIMUM_BLOCK = 3
_CONTEXT_SECONDS = 2.0


@dataclass(frozen=True, slots=True)
class AsrCandidate:
    first: int
    last: int
    primary: tuple[str, ...]
    candidate: tuple[str, ...]
    start: float
    end: float
    left_context: tuple[TimedToken, ...]
    right_context: tuple[TimedToken, ...]
    evidence: tuple[AsrEvidence, ...]
    retained_positions: tuple[int, ...] = ()

    @property
    def text(self) -> str:
        return " ".join(self.candidate)


@dataclass(frozen=True, slots=True)
class _Anchor:
    primary: tuple[TimedToken, ...]
    alternative: tuple[TimedToken, ...]
    first: int
    last: int
    other_first: int
    other_last: int


@dataclass(frozen=True, slots=True)
class _Gap:
    tokens: tuple[TimedToken, ...]
    view: AsrView
    left: _Anchor | None
    right: _Anchor | None


@dataclass(frozen=True, slots=True)
class _Assembly:
    words: tuple[str, ...]
    retained_positions: tuple[int, ...]


def _same_time(left: TimedToken, right: TimedToken) -> bool:
    return max(left.start, right.start) <= min(left.end, right.end) + _MARGIN


def _same_occurrence(left: TimedToken, right: TimedToken) -> bool:
    return token_key(left.text) == token_key(right.text) and _same_time(left, right)


def _matches(
    left: Sequence[TimedToken],
    right: Sequence[TimedToken],
    compatible: Callable[[TimedToken, TimedToken], bool],
) -> list[tuple[int, int]]:
    pairs = [(i, j) for i, a in enumerate(left) for j, b in enumerate(right) if compatible(a, b)]
    scores: list[tuple[int, float]] = []
    previous: list[int | None] = []
    for k, (i, j) in enumerate(pairs):
        distance = abs(left[i].start + left[i].end - right[j].start - right[j].end)
        best, parent = (1, -distance), None
        for h, (a, b) in enumerate(pairs[:k]):
            option = (scores[h][0] + 1, scores[h][1] - distance)
            if a < i and b < j and option > best:
                best, parent = option, h
        scores.append(best)
        previous.append(parent)
    current = max(range(len(scores)), key=scores.__getitem__) if scores else None
    result = []
    while current is not None:
        result.append(pairs[current])
        current = previous[current]
    return list(reversed(result))


def _anchors(primary: AsrView, other: AsrView) -> tuple[_Anchor, ...]:
    blocks: list[list[tuple[int, int]]] = []
    for pair in _matches(primary.tokens, other.tokens, _same_occurrence):
        if blocks and pair == (blocks[-1][-1][0] + 1, blocks[-1][-1][1] + 1):
            blocks[-1].append(pair)
        else:
            blocks.append([pair])
    return tuple(
        _Anchor(
            primary.tokens[block[0][0] : block[-1][0] + 1],
            other.tokens[block[0][1] : block[-1][1] + 1],
            block[0][0],
            block[-1][0] + 1,
            block[0][1],
            block[-1][1] + 1,
        )
        for block in blocks
        if len(block) >= _MINIMUM_BLOCK
    )


def _islands(tokens: Sequence[TimedToken]) -> list[tuple[TimedToken, ...]]:
    groups: list[list[TimedToken]] = []
    end = -float("inf")
    for word in sorted(set(tokens), key=lambda item: (item.start, item.end, item.view_index)):
        if not groups or word.start - end > _CONTEXT_SECONDS:
            groups.append([])
        groups[-1].append(word)
        end = max(end, word.end)
    return [tuple(group) for group in groups]


def _gaps(primary: AsrView, other: AsrView) -> list[_Gap]:
    anchors = _anchors(primary, other)
    if not anchors:
        return []
    boundaries: tuple[_Anchor | None, ...] = (None, *anchors, None)
    result: list[_Gap] = []
    for left, right in zip(boundaries, boundaries[1:]):
        first, last = left.last if left else 0, right.first if right else len(primary.tokens)
        a, b = left.other_last if left else 0, right.other_first if right else len(other.tokens)
        words = [
            word
            for word in (*primary.tokens[first:last], *other.tokens[a:b])
            if word.end > max(primary.start, other.start)
        ]
        result.extend(_Gap(part, other, left, right) for part in _islands(words))
    return result


def _groups(gaps: Sequence[_Gap]) -> list[list[_Gap]]:
    result: list[list[_Gap]] = []
    end = -float("inf")
    for gap in sorted(gaps, key=lambda item: min(word.start for word in item.tokens)):
        if not result or min(word.start for word in gap.tokens) >= end:
            result.append([])
        result[-1].append(gap)
        end = max(end, max(word.end for word in gap.tokens))
    return result


def _orthographic_key(text: str) -> str:
    return "".join(
        char
        for char in unicodedata.normalize("NFD", token_key(text))
        if not unicodedata.combining(char)
    )


def _retained_word(left: TimedToken, right: TimedToken) -> bool:
    return _same_time(left, right) and (
        token_key(left.text) == token_key(right.text)
        or _orthographic_key(left.text) == _orthographic_key(right.text)
    )


def _assembled(
    primary: Sequence[TimedToken], alternative: Sequence[TimedToken]
) -> _Assembly | None:
    matches = _matches(primary, alternative, _retained_word)
    if len(alternative) <= len(primary):
        return None
    if len(matches) != len(primary):
        block = _collapsed_block(primary, alternative)
        if block is None:
            return None
        matches = list(enumerate(block))
    retained = {j: primary[i].text for i, j in matches}
    return _Assembly(
        tuple(retained.get(index, word.text) for index, word in enumerate(alternative)),
        tuple(j for _, j in matches),
    )


def _collapsed_block(
    primary: Sequence[TimedToken], alternative: Sequence[TimedToken]
) -> tuple[int, ...] | None:
    # A whole collapsed phrase can propose text, never timestamps. Its occurrence
    # must be one exact contiguous block; acoustic acceptance remains mandatory.
    if len(primary) < _MINIMUM_BLOCK or any(
        word.end - word.start + 1e-9 >= _CRAMMED_WORD_SECONDS for word in primary
    ):
        return None
    keys = [token_key(word.text) for word in primary]
    other = [token_key(word.text) for word in alternative]
    starts = [
        index
        for index in range(len(other) - len(keys) + 1)
        if other[index : index + len(keys)] == keys
    ]
    return tuple(range(starts[0], starts[0] + len(keys))) if len(starts) == 1 else None


def _context(group: Sequence[_Gap], side: str, start: float, end: float) -> tuple[TimedToken, ...]:
    choices: list[tuple[float, tuple[TimedToken, ...]]] = []
    for gap in group:
        anchor = gap.left if side == "left" else gap.right
        if anchor is None:
            continue
        distance = (
            start - max(anchor.primary[-1].end, anchor.alternative[-1].end)
            if side == "left"
            else min(anchor.primary[0].start, anchor.alternative[0].start) - end
        )
        intervening = any(
            word not in gap.tokens
            and word not in anchor.alternative
            and (
                anchor.alternative[-1].end < word.end and word.start < start
                if side == "left"
                else end < word.end and word.start < anchor.alternative[0].start
            )
            for word in gap.view.tokens
        )
        if distance >= -_MARGIN and not intervening:
            words = (
                anchor.primary[-_MINIMUM_BLOCK:]
                if side == "left"
                else anchor.primary[:_MINIMUM_BLOCK]
            )
            choices.append((abs(distance), words))
    return min(choices, key=lambda item: item[0])[1] if choices else ()


def _proposals(primary: AsrView, group: Sequence[_Gap], duration: float) -> list[AsrCandidate]:
    words = set(word for gap in group for word in gap.tokens)
    start, end = min(word.start for word in words), max(word.end for word in words)
    retained = tuple(word for word in primary.tokens if word in words)
    positions = [index for index, word in enumerate(primary.tokens) if word in words]
    if positions and positions != list(range(positions[0], positions[-1] + 1)):
        return []
    first = (
        positions[0]
        if positions
        else next(
            (index for index, word in enumerate(primary.tokens) if word.start >= end),
            len(primary.tokens),
        )
    )
    last = positions[-1] + 1 if positions else first
    left, right = _context(group, "left", start, end), _context(group, "right", start, end)
    # A later observed island bounds an isolated fragment; an open outro reaches the audio end.
    following = [word.start for word in primary.tokens[last:] if word.start > end]
    right_bound = min(following) if following else duration
    crop_start = max(0.0, start - _MARGIN)
    crop_end = min(right_bound, end + _MARGIN) if following else duration
    if left:
        crop_start = max(crop_start, left[-1].end)
    if right:
        crop_end = min(right_bound, right[0].start)
    template = AsrCandidate(
        first,
        last,
        tuple(word.text for word in retained),
        (),
        crop_start,
        crop_end,
        left,
        right,
        (),
    )
    return _variants(template, retained, group, words, start, end)


def _variants(
    template: AsrCandidate,
    retained: tuple[TimedToken, ...],
    group: Sequence[_Gap],
    words: set[TimedToken],
    start: float,
    end: float,
) -> list[AsrCandidate]:
    result: dict[tuple[tuple[str, ...], tuple[int, ...]], AsrCandidate] = {}
    for view in dict.fromkeys(gap.view for gap in group):
        alternative = _observed_span(view, words, start, end)
        if not alternative:
            continue
        assembled = _assembled(retained, alternative)
        if assembled is None or not template.start < template.end:
            continue
        key = tuple(map(token_key, assembled.words)), assembled.retained_positions
        evidence = AsrEvidence(view.source_id, view.index, view.start, view.end, alternative)
        if key in result:
            result[key] = replace(result[key], evidence=(*result[key].evidence, evidence))
        else:
            result[key] = replace(
                template,
                candidate=assembled.words,
                evidence=(evidence,),
                retained_positions=assembled.retained_positions,
            )
    return list(result.values())


def _observed_span(
    view: AsrView, words: set[TimedToken], start: float, end: float
) -> tuple[TimedToken, ...]:
    indices = [index for index, word in enumerate(view.tokens) if word in words]
    if (
        not indices
        or not view.start <= start < end <= view.end
        or indices != list(range(indices[0], indices[-1] + 1))
    ):
        return ()
    return tuple(view.tokens[index] for index in indices)


def insertion_candidates(
    lyrics: str, views: Sequence[Mapping[str, object]], duration: float
) -> tuple[AsrCandidate, ...]:
    """Propose immutable insertions; only an independent acoustic resolver may accept them."""
    parsed = read_views(views, duration)
    if not parsed or parsed[0].index != 0:
        return ()
    baseline, primary = lyrics.split(), parsed[0]
    keys = list(map(token_key, baseline))
    if keys != list(map(token_key, display_tokens(primary.text))) or keys != [
        token_key(word.text) for word in primary.tokens
    ]:
        return ()
    primary = replace(
        primary,
        tokens=tuple(
            replace(word, text=text) for word, text in zip(primary.tokens, baseline, strict=True)
        ),
    )
    gaps = [gap for view in parsed[1:] for gap in _gaps(primary, view)]
    return tuple(
        candidate for group in _groups(gaps) for candidate in _proposals(primary, group, duration)
    )
