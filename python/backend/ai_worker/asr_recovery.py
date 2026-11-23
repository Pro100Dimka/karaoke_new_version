from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import partial
from itertools import pairwise
from math import ceil, floor, isfinite
import re

import numpy as np
import torch

from backend.ai_worker import ctc
from backend.ai_worker.asr_candidates import AsrCandidate, _anchors, _MARGIN, insertion_candidates
from backend.ai_worker.asr_views import AsrView, TimedToken, read_views, token_key
from backend.ai_worker.recognition import HeardWord, heard_timings, heard_words
from backend.ai_worker.speech_observations import RecognitionObservations, recognition_views
from backend.ai_worker.timing import voiced_frames


_RATE = 16_000
_HOP = 160


@dataclass(frozen=True, slots=True)
class _Accepted:
    proposal: AsrCandidate
    gain: float


def _valid_proposal(proposal: AsrCandidate, baseline: Sequence[str], duration: float) -> bool:
    kept = proposal.retained_positions
    return (
        0 <= proposal.first <= proposal.last <= len(baseline)
        and proposal.primary == tuple(baseline[proposal.first : proposal.last])
        and len(proposal.candidate) > len(proposal.primary)
        and len(kept) == len(proposal.primary)
        and tuple(sorted(set(kept))) == kept
        and all(0 <= index < len(proposal.candidate) for index in kept)
        and tuple(proposal.candidate[index] for index in kept) == proposal.primary
        and all(token_key(word) for word in proposal.candidate)
        and isfinite(proposal.start)
        and isfinite(proposal.end)
        and 0 <= proposal.start < proposal.end <= duration
        and _complete_evidence(proposal)
    )


def _complete_evidence(proposal: AsrCandidate) -> bool:
    return any(
        evidence.source_id
        and evidence.crop_start <= proposal.start < proposal.end <= evidence.crop_end
        and len(evidence.observed) == len(proposal.candidate)
        and all(
            isfinite(word.start)
            and isfinite(word.end)
            and evidence.crop_start <= word.start < word.end <= evidence.crop_end
            and word.source_id == evidence.source_id
            and (
                index in proposal.retained_positions
                or token_key(word.text) == token_key(proposal.candidate[index])
            )
            for index, word in enumerate(evidence.observed)
        )
        for evidence in proposal.evidence
    )


def _context_anchor(
    context: Sequence[TimedToken], scores: torch.Tensor, step: float, *, left: bool
) -> ctc.AlignedWord | None:
    if not context:
        return None
    first = max(0, floor((context[0].start - _MARGIN) / step + 1e-9))
    last = min(len(scores), ceil((context[-1].end + _MARGIN) / step - 1e-9))
    if first >= last:
        return None
    try:
        words = ctc.align_words(
            scores[first:last],
            step,
            [word.text for word in context],
            first * step,
            bounded_end=True,
        )
    except (ValueError, RuntimeError):
        return None
    core, heard = (words[-1], context[-1]) if left else (words[0], context[0])
    return (
        core
        if (
            core.score > ctc._PREFERENCE
            and core.start < heard.end + _MARGIN
            and core.end > heard.start - _MARGIN
        )
        else None
    )


def _bounded_frames(proposal: AsrCandidate, scores: torch.Tensor, step: float) -> tuple[int, int]:
    start, end = proposal.start, min(proposal.end, len(scores) * step)
    left = _context_anchor(proposal.left_context, scores, step, left=True)
    right = _context_anchor(proposal.right_context, scores, step, left=False)
    if (proposal.left_context and left is None) or (proposal.right_context and right is None):
        return 0, 0
    # Only independently located neighbours are anchors: missing text can make
    # whole-song CTC borrow a strong phoneme from inside the omitted phrase.
    if left is not None:
        start = max(start, left.end)
    if right is not None:
        end = min(end, right.start)
    return max(0, ceil(start / step - 1e-9)), min(len(scores), floor(end / step + 1e-9))


def _path_score(scores: torch.Tensor, words: Sequence[str]) -> float:
    context = " ".join(words)
    tokens = [
        token
        for word in words
        for letters in ctc._character_tokens(word, context)
        for token in letters
    ]
    if not tokens:
        if words:
            raise ValueError("A proposed word has no acoustic tokens")
        return float(scores[:, 0].double().sum())
    if max(tokens) >= scores.shape[1]:
        raise ValueError("The emission alphabet cannot represent this transcript")
    path = ctc._transcript_path(scores, tokens, bounded_end=True)[0].to(torch.long)
    return float(scores[torch.arange(len(scores), device=scores.device), path].double().sum())


def _new_runs(proposal: AsrCandidate) -> list[range]:
    kept = set(proposal.retained_positions)
    runs: list[range] = []
    first = None
    for index in range(len(proposal.candidate) + 1):
        if index < len(proposal.candidate) and index not in kept:
            first = index if first is None else first
        elif first is not None:
            runs.append(range(first, index))
            first = None
    return runs


def _run_supported(words: Sequence[ctc.AlignedWord]) -> bool:
    # Keep the existing acoustic repeat-support floor and majority. Recognition
    # generated the proposal, so RecognizedWord cannot count as acoustic proof.
    supported = [word for word in words if word.score >= 0.1]
    return (
        bool(words)
        and words[0].score >= 0.1
        and max(
            len(supported) / len(words),
            sum(len(token_key(word.text)) for word in supported)
            / max(1, sum(len(token_key(word.text)) for word in words)),
        )
        >= 0.6
    )


def _accept(proposal: AsrCandidate, scores: torch.Tensor, step: float) -> _Accepted | None:
    first, last = _bounded_frames(proposal, scores, step)
    if first >= last:
        return None
    crop = scores[first:last]
    try:
        candidate = _path_score(crop, proposal.candidate)
        primary = _path_score(crop, proposal.primary)
        blank = _path_score(crop, ())
        if not isfinite(candidate) or candidate <= max(primary, blank):
            return None
        words = ctc.align_words(crop, step, proposal.candidate, first * step, bounded_end=True)
    except (ValueError, RuntimeError):
        return None
    if not all(_run_supported([words[index] for index in run]) for run in _new_runs(proposal)):
        return None
    return _Accepted(proposal, candidate - max(primary, blank))


def _overlaps(left: AsrCandidate, right: AsrCandidate) -> bool:
    same_insertion = left.first == left.last == right.first == right.last
    return (
        (left.first == right.first and not same_insertion)
        or max(left.first, right.first) < min(left.last, right.last)
        or max(left.start, right.start) < min(left.end, right.end)
    )


def _apply(lyrics: str, accepted: Sequence[_Accepted]) -> str:
    spans = list(re.finditer(r"\S+", lyrics))
    selected: list[AsrCandidate] = []
    for item in sorted(accepted, key=lambda item: item.gain, reverse=True):
        if not any(_overlaps(item.proposal, previous) for previous in selected):
            selected.append(item.proposal)
    result = lyrics
    # Separate sung islands can share one text gap. Insert the later island
    # first so that inserting the earlier one preserves their acoustic order.
    for proposal in sorted(selected, key=lambda item: (item.first, item.start), reverse=True):
        if proposal.first < proposal.last:
            first, last = spans[proposal.first].start(), spans[proposal.last - 1].end()
            text = proposal.text
        elif proposal.first < len(spans):
            first = last = spans[proposal.first].start()
            text = proposal.text + " "
        else:
            first = last = spans[-1].end() if spans else len(lyrics)
            text = (" " if spans else "") + proposal.text
        result = result[:first] + text + result[last:]
    return result


def recover_lyrics(
    lyrics: str,
    views: Sequence[Mapping[str, object]],
    scores: torch.Tensor,
    step: float,
    duration: float,
) -> str:
    """Add only independently observed words corroborated by the existing emission."""
    if (
        not isfinite(step)
        or step <= 0
        or not isfinite(duration)
        or duration <= 0
        or scores.ndim != 2
        or not len(scores)
        or scores.shape[1] < 2
        or not torch.isfinite(scores).all()
    ):
        return lyrics
    baseline = lyrics.split()
    proposals = [
        item
        for item in insertion_candidates(lyrics, views, duration)
        if _valid_proposal(item, baseline, duration)
    ]
    if not proposals:
        return lyrics
    accepted = [item for proposal in proposals if (item := _accept(proposal, scores, step))]
    return _apply(lyrics, accepted) if accepted else lyrics


def recover_missed_phrases(
    lyrics: str,
    primary: Sequence[HeardWord],
    samples: np.ndarray,
    scores: torch.Tensor,
    step: float,
    recognize: Callable[[float, float], Sequence[Mapping[str, object]]],
) -> tuple[str, list[HeardWord]]:
    """Review long internal ASR gaps with sustained vocal activity and two fresh views."""
    spans = list(re.finditer(r"\S+", lyrics))
    gaps = _missed_gaps([span[0] for span in spans], primary)
    if not gaps:
        return lyrics, []

    activity = voiced_frames(samples, _RATE, _HOP)
    duration = len(samples) / _RATE
    inserted: list[HeardWord] = []
    for right, gap_start, gap_end in reversed(gaps):
        flags = activity[ceil(gap_start * _RATE / _HOP) : floor(gap_end * _RATE / _HOP)]
        if not len(flags) or np.mean(flags) < 0.35:
            continue
        start = max(0.0, gap_start - 3.0)
        end = min(duration, gap_end + 3.0, start + 30.0)
        try:
            views = read_views(recognize(start, end), duration)
        except (FileNotFoundError, OSError, RuntimeError, ValueError):
            continue
        if len(views) != 2:
            continue
        phrases = _gap_phrases(views, gap_start, gap_end, scores, step)
        if phrases:
            at = spans[right].start()
            text = "\n".join(" ".join(word.text for word in phrase) for phrase in phrases)
            lyrics = lyrics[:at].rstrip() + "\n" + text + "\n" + lyrics[at:]
            inserted.extend(
                (token_key(word.text), word.start, word.end)
                for phrase in phrases
                for word in phrase
            )
    return lyrics, inserted


def _missed_gaps(words: list[str], primary: Sequence[HeardWord]) -> list[tuple[int, float, float]]:
    timings = heard_timings(words, list(primary), minimum_block=3)
    return [
        (right, timings[left][1], timings[right][0])
        for left, right in pairwise(sorted(timings))
        if right == left + 1 and 8 <= timings[right][0] - timings[left][1] <= 26
    ]


def _gap_phrases(
    views: Sequence[AsrView],
    gap_start: float,
    gap_end: float,
    scores: torch.Tensor,
    step: float,
) -> list[list[ctc.AlignedWord]]:
    inside = [
        replace(
            view,
            tokens=tuple(
                word for word in view.tokens if gap_start <= word.start < word.end <= gap_end
            ),
        )
        for view in views
    ]
    result: list[list[ctc.AlignedWord]] = []
    for match in _anchors(inside[0], inside[1]):
        first = max(ceil(gap_start / step), floor((match.primary[0].start - 0.25) / step))
        last = min(len(scores), floor(gap_end / step), ceil((match.primary[-1].end + 0.25) / step))
        words = [word.text for word in match.primary]
        local = scores[first:last]
        if not len(local):
            continue
        try:
            aligned = ctc.align_words(local, step, words, first * step, bounded_end=True)
            gain = _path_score(local, words) - _path_score(local, ())
        except (ValueError, RuntimeError):
            continue
        agrees = all(
            min(a.start, b.start) - 0.3 <= word.start <= max(a.end, b.end) + 0.3
            for word, a, b in zip(aligned, match.primary, match.alternative, strict=True)
        )
        ordered = not result or result[-1][-1].end <= aligned[0].start
        if gain > 0 and _run_supported(aligned) and agrees and ordered:
            result.append(aligned)
    return result


def _gap_recognition(
    audio: np.ndarray,
    backing: np.ndarray,
    decode: Callable[[np.ndarray], Mapping[str, object]],
    start: float,
    end: float,
) -> list[Mapping[str, object]]:
    first, last = round(start * _RATE), round(end * _RATE)
    vocal, instrumental = audio[first:last], backing[first:last]
    mix = vocal + np.pad(instrumental, (0, len(vocal) - len(instrumental)))
    if np.array_equal(vocal, mix):
        return []
    return [
        dict(decode(samples), sourceId=source, cropStart=first / _RATE, cropEnd=last / _RATE)
        for source, samples in (("vocal", vocal), ("mix", mix))
    ]


def review_transcript_gaps(
    lyrics: str,
    heard: list[HeardWord],
    observations: RecognitionObservations,
    backing: np.ndarray | None,
    scores: torch.Tensor,
    step: float,
    decode: Callable[[np.ndarray], Mapping[str, object]],
) -> tuple[str, list[HeardWord]]:
    if backing is None or observations.recognition is None:
        return lyrics, heard
    audio = observations.samples
    lyrics, recovered = recover_missed_phrases(
        lyrics,
        heard_words(observations.recognition),
        audio,
        scores,
        step,
        partial(_gap_recognition, audio, backing, decode),
    )
    if not recovered:
        return lyrics, heard
    reliable = [
        word
        for word in heard
        if all(word[2] <= start or end <= word[1] for _, start, end in recovered)
    ]
    return lyrics, sorted([*reliable, *recovered], key=lambda word: (word[1], word[2]))


def recover_transcript_lyrics(
    lyrics: str,
    observations: RecognitionObservations,
    scores: torch.Tensor,
    step: float,
    baseline_lyrics: str = "",
) -> tuple[str, bool]:
    views = [*recognition_views(observations.recognition), *observations.views]
    duration = len(observations.samples) / _RATE
    floor = baseline_lyrics or lyrics
    recovered = recover_lyrics(floor, views, scores, step, duration) if views else floor
    remaining = iter(map(token_key, recovered.split()))
    # Keep the existing acoustic review for proposed repeats absent from the recovered text.
    preserved = all(
        any(word == expected for word in remaining) for expected in map(token_key, lyrics.split())
    )
    return (recovered, True) if preserved else (lyrics, False)
