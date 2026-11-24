from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from math import isfinite

from backend.text_normalization import clean_lyric_punctuation


@dataclass(frozen=True, slots=True)
class TimedToken:
    text: str
    start: float
    end: float
    source_id: str
    view_index: int
    native_index: int


@dataclass(frozen=True, slots=True)
class AsrEvidence:
    source_id: str
    view_index: int
    crop_start: float
    crop_end: float
    observed: tuple[TimedToken, ...]


@dataclass(frozen=True, slots=True)
class AsrView:
    source_id: str
    index: int
    start: float
    end: float
    text: str
    tokens: tuple[TimedToken, ...]


def token_key(text: str) -> str:
    return "".join(char for char in text.casefold() if char.isalnum())


def display_tokens(text: str) -> tuple[str, ...]:
    # Match lyric punctuation handling without changing spelling or inventing subword times.
    value = clean_lyric_punctuation(text).replace("'", "")
    return tuple(word for word in value.split() if token_key(word))


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        result = float(value)
    except (ValueError, OverflowError):
        return None
    return result if isfinite(result) else None


def _tokens(
    raw: Mapping[str, object], source: str, index: int, start: float, end: float
) -> tuple[TimedToken, ...]:
    segments = raw.get("segments")
    if not isinstance(segments, list):
        return ()
    tokens: list[TimedToken] = []
    native_index = 0
    for segment in segments:
        if not isinstance(segment, Mapping) or not isinstance(segment.get("words"), list):
            continue
        for word in segment["words"]:
            native_index += 1
            if not isinstance(word, Mapping) or not isinstance(word.get("word"), str):
                continue
            interval = _native_interval(word, start, end)
            if interval is None:
                continue
            first, last = interval
            parts = display_tokens(word["word"])
            if len(parts) > 1:
                # Normalization cannot manufacture several anchors from one native observation.
                return ()
            if parts and any(char.isalpha() for char in parts[0]):
                tokens.append(TimedToken(parts[0], first, last, source, index, native_index - 1))
    if any(right.start < left.start for left, right in zip(tokens, tokens[1:])):
        return ()
    return tuple(tokens)


def _native_interval(
    word: Mapping[str, object], start: float, end: float
) -> tuple[float, float] | None:
    first, last = _number(word.get("start")), _number(word.get("end"))
    if first is None or last is None or not 0 <= first < last:
        return None
    first, last = first + start, last + start
    return (first, last) if start <= first < last <= end else None


def read_views(raw: Sequence[Mapping[str, object]], duration: float) -> tuple[AsrView, ...]:
    if not isfinite(duration) or duration <= 0:
        return ()
    result: list[AsrView] = []
    seen: set[tuple[str, float, float]] = set()
    for index, item in enumerate(raw):
        source, text = item.get("sourceId"), item.get("text")
        start = _number(item.get("cropStart", item.get("startSeconds", 0.0)))
        end = _number(item.get("cropEnd", duration))
        if (
            not isinstance(source, str)
            or not source
            or not isinstance(text, str)
            or start is None
            or end is None
            or not 0 <= start < end <= duration
            or (source, start, end) in seen
        ):
            continue
        seen.add((source, start, end))
        result.append(
            AsrView(source, index, start, end, text, _tokens(item, source, index, start, end))
        )
    return tuple(result)
