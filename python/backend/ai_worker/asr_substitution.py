from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from math import ceil, floor, isfinite
import re

import torch

from backend.ai_worker import asr_candidates, ctc
from backend.ai_worker.asr_recovery import _path_score, _run_supported
from backend.ai_worker.asr_views import AsrView, TimedToken, display_tokens, read_views, token_key
from backend.ai_worker.recognition import alignment_payload
from backend.ai_worker.speech_windows import _MARGIN_SECONDS, _SAMPLE_RATE

WordPayload = Mapping[str, object]
Interval = tuple[float, float]


@dataclass(frozen=True, slots=True)
class _Observation:
    view: AsrView
    words: tuple[TimedToken, ...]
    probabilities: tuple[float, ...] | None


@dataclass(frozen=True, slots=True)
class _Proposal:
    primary: tuple[TimedToken, ...]
    probabilities: tuple[float, ...] | None
    evidence: tuple[_Observation, ...]
    left: tuple[TimedToken, ...]
    right: tuple[TimedToken, ...]


@dataclass(frozen=True, slots=True)
class _Edit:
    first: int
    last: int
    words: tuple[WordPayload, ...]
    start: float
    end: float


def substitute_alignment(
    lyrics: str,
    payload: Mapping[str, object],
    views: Sequence[Mapping[str, object]],
    scores: torch.Tensor,
    step: float,
    duration: float,
) -> tuple[str, Mapping[str, object]]:
    """Correct corroborated ASR disputes after insertion/repeat verification.

    The caller invokes this only for ASR lyrics. Outside word payloads are kept
    literally; bounded acoustic cores are never sent through whole-song CTC again.
    """
    words = _payload_words(lyrics, payload)
    if words is None or not _valid_scores(scores, step, duration):
        return lyrics, payload
    edits = [
        edit
        for proposal in _proposals(views, duration)
        if (edit := _edit(proposal, words, scores, step, duration)) is not None
    ]
    unique = [
        edit
        for edit in edits
        if not any(other is not edit and _overlap(edit, other) for other in edits)
    ]
    if not unique:
        return lyrics, payload
    text, corrected = _apply(lyrics, words, unique)
    return text, dict(payload, words=corrected)


def _valid_scores(scores: torch.Tensor, step: float, duration: float) -> bool:
    return (
        isfinite(step)
        and step > 0
        and isfinite(duration)
        and duration > 0
        and abs(step * _SAMPLE_RATE - ctc.frame_stride_samples()) < 1e-8
        and scores.ndim == 2
        and len(scores) > 0
        and scores.shape[1] > 1
        and bool(torch.isfinite(scores).all())
    )


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not isfinite(value):
        return None
    return float(value)


def _probabilities(
    raw: Mapping[str, object], words: Sequence[TimedToken]
) -> tuple[float, ...] | None:
    segments = raw.get("segments")
    if not isinstance(segments, list):
        return None
    values: list[float | None] = []
    for segment in segments:
        if not isinstance(segment, Mapping) or not isinstance(segment.get("words"), list):
            continue
        values.extend(
            _number(word.get("probability")) if isinstance(word, Mapping) else None
            for word in segment["words"]
        )
    selected = [
        values[word.native_index] if word.native_index < len(values) else None for word in words
    ]
    if not selected or any(value is None or not 0 <= value <= 1 for value in selected):
        return None
    return tuple(value for value in selected if value is not None)


def _proposals(raw: Sequence[Mapping[str, object]], duration: float) -> list[_Proposal]:
    views = read_views(raw, duration)
    if not views or views[0].index != 0:
        return []
    primary = views[0]
    if [token_key(word) for word in display_tokens(primary.text)] != [
        token_key(word.text) for word in primary.tokens
    ]:
        return []
    gaps = [gap for view in views[1:] for gap in asr_candidates._gaps(primary, view)]
    return [
        proposal
        for group in asr_candidates._groups(gaps)
        for proposal in _variants(primary, group, raw)
    ]


def _variants(
    primary: AsrView,
    group: Sequence[asr_candidates._Gap],
    raw: Sequence[Mapping[str, object]],
) -> list[_Proposal]:
    words = set(word for gap in group for word in gap.tokens)
    kept = tuple(word for word in primary.tokens if word in words)
    positions = [index for index, word in enumerate(primary.tokens) if word in words]
    if not kept or positions != list(range(positions[0], positions[-1] + 1)):
        return []
    start, end = min(word.start for word in words), max(word.end for word in words)
    variants: dict[tuple[str, ...], list[_Observation]] = {}
    for view in sorted(set(gap.view for gap in group), key=lambda item: item.index):
        observed = asr_candidates._observed_span(view, words, start, end)
        if not observed or asr_candidates._assembled(kept, observed) is not None:
            continue
        key = tuple(token_key(word.text) for word in observed)
        if key != tuple(token_key(word.text) for word in kept):
            variants.setdefault(key, []).append(
                _Observation(view, observed, _probabilities(raw[view.index], observed))
            )
    return [
        _Proposal(
            kept,
            _probabilities(raw[0], kept),
            tuple(evidence),
            asr_candidates._context(group, "left", start, end),
            asr_candidates._context(group, "right", start, end),
        )
        for evidence in variants.values()
    ]


def _independent(proposal: _Proposal) -> bool:
    pairs = {(item.view.source_id, item.view.start, item.view.end) for item in proposal.evidence}
    sources = {source for source, _, _ in pairs}
    contexts = {(start, end) for _, start, end in pairs}
    # Confirm a source change at one context and a context change for one source.
    # Two observations that change both dimensions cannot provide both controls.
    return (
        len(sources) >= 2
        and len(contexts) >= 2
        and any(
            sum((source, start, end) in pairs for source in sources) >= 2 for start, end in contexts
        )
        and any(
            sum((source, start, end) in pairs for start, end in contexts) >= 2 for source in sources
        )
    )


def _more_confident(proposal: _Proposal) -> bool:
    deleted = _deleted(proposal)
    if (
        proposal.probabilities is None
        or any(item.probabilities is None for item in proposal.evidence)
        or deleted is None
    ):
        return False
    values = [value for item in proposal.evidence for value in item.probabilities or ()]
    return bool(values) and min(values) > max(proposal.probabilities[index] for index in deleted)


def _deleted(proposal: _Proposal) -> tuple[int, ...] | None:
    retained: list[int] = []
    deleted: list[int] = []
    for index, word in enumerate(proposal.primary):
        matches = [
            position
            for position in range(len(proposal.evidence[0].words))
            if all(
                asr_candidates._same_occurrence(word, item.words[position])
                for item in proposal.evidence
            )
        ]
        if len(matches) > 1:
            return None
        if matches:
            retained.append(matches[0])
        else:
            deleted.append(index)
    if retained != sorted(set(retained)):
        return None
    return tuple(deleted) if deleted else None


def _consensus(proposal: _Proposal) -> list[Interval] | None:
    if not _independent(proposal) or not _more_confident(proposal):
        return None
    intervals: list[Interval] = []
    for index in range(len(proposal.evidence[0].words)):
        words = [item.words[index] for item in proposal.evidence]
        start, end = max(word.start for word in words), min(word.end for word in words)
        if start >= end or start - min(word.start for word in words) > _MARGIN_SECONDS:
            return None
        if intervals and intervals[-1][1] > start:
            return None
        intervals.append((start, end))
    return intervals


def _payload_words(lyrics: str, payload: Mapping[str, object]) -> list[WordPayload] | None:
    values = payload.get("words")
    text = lyrics.split()
    if not isinstance(values, list) or len(values) != len(text):
        return None
    if any(
        not isinstance(word, Mapping) or word.get("text") != token
        for word, token in zip(values, text)
    ):
        return None
    return list(values)


def _span(word: WordPayload) -> Interval | None:
    start, end = _number(word.get("start")), _number(word.get("end"))
    return (start, end) if start is not None and end is not None and 0 <= start < end else None


def _same_occurrence(word: WordPayload, heard: TimedToken) -> bool:
    span, text = _span(word), word.get("text")
    return (
        span is not None
        and isinstance(text, str)
        and token_key(text) == token_key(heard.text)
        and abs(span[0] - heard.start) <= _MARGIN_SECONDS
        and max(span[0], heard.start) < min(span[1], heard.end) + _MARGIN_SECONDS
    )


def _occurrence(proposal: _Proposal, words: Sequence[WordPayload]) -> tuple[int, int] | None:
    size = len(proposal.primary)
    positions = [
        index
        for index in range(len(words) - size + 1)
        if all(
            _same_occurrence(words[index + offset], token)
            for offset, token in enumerate(proposal.primary)
        )
    ]
    return (positions[0], positions[0] + size) if len(positions) == 1 else None


def _anchor(word: WordPayload, *, left: bool) -> float | None:
    span, confidence = _span(word), _number(word.get("confidence"))
    letters, text = word.get("letters"), word.get("text")
    if span is None or confidence is None or confidence <= ctc._PREFERENCE:
        return None
    if not isinstance(text, str) or not isinstance(letters, list) or len(letters) != len(text):
        return None
    moments = [_number(value) for value in letters]
    if any(value is None or not span[0] <= value <= span[1] for value in moments):
        return None
    return span[1] if left else span[0]


def _neighbor_matches(
    proposal: _Proposal, words: Sequence[WordPayload], first: int, last: int
) -> bool:
    if not proposal.left and not proposal.right:
        return False
    if (not proposal.left and first != 0) or (not proposal.right and last != len(words)):
        return False
    if first < len(proposal.left) or len(words) - last < len(proposal.right):
        return False
    neighbors = [
        *zip(words[first - len(proposal.left) : first], proposal.left, strict=True),
        *zip(words[last : last + len(proposal.right)], proposal.right, strict=True),
    ]
    return all(_same_occurrence(word, token) for word, token in neighbors)


def _bounds(
    proposal: _Proposal, words: Sequence[WordPayload], first: int, last: int, duration: float
) -> Interval | None:
    if not _neighbor_matches(proposal, words, first, last):
        return None
    start = _anchor(words[first - 1], left=True) if proposal.left else 0.0
    end = _anchor(words[last], left=False) if proposal.right else duration
    return (start, end) if start is not None and end is not None and start < end else None


def _core(
    text: str, interval: Interval, bounds: Interval, scores: torch.Tensor, step: float
) -> ctc.AlignedWord | None:
    first = max(ceil(bounds[0] / step - 1e-9), floor(interval[0] / step + 1e-9))
    last = min(len(scores), floor(bounds[1] / step + 1e-9), ceil(interval[1] / step - 1e-9))
    tokens = [token for letters in ctc._character_tokens(text, text) for token in letters]
    if first >= last or not tokens or max(tokens) >= scores.shape[1]:
        return None
    try:
        return ctc.align_words(scores[first:last], step, [text], first * step, bounded_end=True)[0]
    except (ValueError, RuntimeError):
        return None


def _cores(
    proposal: _Proposal,
    intervals: Sequence[Interval],
    bounds: Interval,
    scores: torch.Tensor,
    step: float,
) -> list[ctc.AlignedWord] | None:
    result: list[ctc.AlignedWord] = []
    for word, interval in zip(proposal.evidence[0].words, intervals, strict=True):
        core = _core(word.text, interval, bounds, scores, step)
        if core is None or (result and result[-1].end > core.start + 1e-9):
            return None
        if core.start < interval[0] - step or core.end > interval[1] + step:
            return None
        result.append(core)
    return result if _supported_changes(proposal, result) else None


def _supported_changes(proposal: _Proposal, words: Sequence[ctc.AlignedWord]) -> bool:
    retained = {
        position
        for position in range(len(words))
        if any(
            all(
                asr_candidates._same_occurrence(word, item.words[position])
                for item in proposal.evidence
            )
            for word in proposal.primary
        )
    }
    runs: list[list[ctc.AlignedWord]] = [[]]
    for index, word in enumerate(words):
        if index in retained:
            if runs[-1]:
                runs.append([])
        else:
            runs[-1].append(word)
    # A known word cannot lend its confidence to a separate, unsupported change.
    return any(runs) and all(_run_supported(run) for run in runs if run)


def _reviewed(words: Sequence[ctc.AlignedWord]) -> list[ctc.AlignedWord]:
    return [
        replace(
            word,
            diagnostics=(
                "ConsensusTranscriptCorrection",
                *(
                    (
                        "ApproximateLetterTiming",
                        "LetterTimingReviewRequired",
                        "TimingReviewRequired",
                    )
                    if word.score < 0.1
                    else ()
                ),
            ),
        )
        for word in words
    ]


def _primary_supported(
    word: TimedToken, bounds: Interval, scores: torch.Tensor, step: float
) -> bool:
    first = max(ceil(bounds[0] / step - 1e-9), floor((word.start - _MARGIN_SECONDS) / step + 1e-9))
    last = min(
        len(scores),
        floor(bounds[1] / step + 1e-9),
        ceil((word.end + _MARGIN_SECONDS) / step - 1e-9),
    )
    if first >= last:
        return True
    crop = scores[first:last]
    try:
        primary, blank = _path_score(crop, [word.text]), _path_score(crop, ())
    except (ValueError, RuntimeError):
        return True
    # Test each removed word independently: an unsupported neighbour must not
    # hide the positive acoustic evidence for a word that is actually sung.
    return not isfinite(primary) or not isfinite(blank) or primary > blank


def _edit(
    proposal: _Proposal,
    words: Sequence[WordPayload],
    scores: torch.Tensor,
    step: float,
    duration: float,
) -> _Edit | None:
    intervals, occurrence, deleted = (
        _consensus(proposal),
        _occurrence(proposal, words),
        _deleted(proposal),
    )
    if intervals is None or occurrence is None or deleted is None:
        return None
    first, last = occurrence
    bounds = _bounds(proposal, words, first, last, duration)
    if bounds is None or any(
        _primary_supported(proposal.primary[index], bounds, scores, step) for index in deleted
    ):
        return None
    if (cores := _cores(proposal, intervals, bounds, scores, step)) is None:
        return None
    values = alignment_payload(_reviewed(cores), dict(enumerate(intervals)))["words"]
    return _Edit(first, last, tuple(values), cores[0].start, cores[-1].end)


def _overlap(left: _Edit, right: _Edit) -> bool:
    return max(left.first, right.first) < min(left.last, right.last) or max(
        left.start, right.start
    ) < min(left.end, right.end)


def _apply(
    lyrics: str, words: Sequence[WordPayload], edits: Sequence[_Edit]
) -> tuple[str, list[WordPayload]]:
    spans = list(re.finditer(r"\S+", lyrics))
    text, result = lyrics, list(words)
    for edit in sorted(edits, key=lambda item: item.first, reverse=True):
        replacement = " ".join(str(word["text"]) for word in edit.words)
        text = text[: spans[edit.first].start()] + replacement + text[spans[edit.last - 1].end() :]
        result[edit.first : edit.last] = edit.words
    return text, result
