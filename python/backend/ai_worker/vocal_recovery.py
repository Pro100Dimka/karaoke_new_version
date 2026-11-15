from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from itertools import groupby
import numpy as np
import torch
from whisper.audio import CHUNK_LENGTH
from backend.ai_worker.ctc import AlignedWord, _PREFERENCE, _evenly
from backend.ai_worker.ctc_tokens import _character_tokens
from backend.ai_worker.guidance_phrases import _key
from backend.ai_worker.timing import _bridged, _runs
from backend.processing.reporting import _timing_load

_MARGIN = 0.6
_STEP = 0.01


def with_acoustic_repeats(
    words: list[AlignedWord],
    onsets: Sequence[float],
    acoustic: tuple[np.ndarray, np.ndarray],
    activity: np.ndarray,
    levels: np.ndarray,
    heard: Mapping[int, tuple[float, float]],
) -> list[AlignedWord]:
    """Retain every written repeat, recovering short consonant breaks missed by loudness onsets."""
    return _RepeatRecovery(words, onsets, acoustic, activity, levels, heard).run()


def recover_vocalizations(
    words: Sequence[AlignedWord],
    scores: torch.Tensor | None,
    step: float,
    activity: np.ndarray,
    periodicity: np.ndarray,
    recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]],
) -> list[AlignedWord]:
    """Recover or extend held vowels only when recognition agrees with CTC and phonation."""
    words = [word for word in words if "BackingVocalOverlap" not in word.diagnostics]
    if scores is None or not words or not activity.any():
        return []
    return _VocalizationRecovery(words, scores, step, activity, periodicity).run(recognize)


@dataclass(frozen=True, slots=True)
class _VocalizationRecovery:
    words: Sequence[AlignedWord]
    scores: torch.Tensor
    step: float
    activity: np.ndarray
    periodicity: np.ndarray

    def run(
        self,
        recognize: Callable[[Sequence[tuple[float, float, str | None]]], Mapping[str, object]],
    ) -> list[AlignedWord]:
        vowels = [token[0] for token in _character_tokens("aeiou")]
        probabilities = self.scores.exp()
        # A CTC blank is an unlabelled frame, not a competing sung consonant.
        support = probabilities[:, vowels] / probabilities[:, 1:].sum(
            dim=1, keepdim=True
        ).clamp_min(1e-12)
        support = support.masked_fill(probabilities[:, vowels] <= _PREFERENCE, 0)
        candidates = self._candidates(vowels, support)
        if not candidates:
            return []
        try:
            results = recognize([(start, end, None) for _, _, start, end, _ in candidates]).get(
                "contexts", []
            )
        except (FileNotFoundError, OSError, RuntimeError, ValueError):
            return []
        recovered: list[AlignedWord] = []
        for (begin, finish, _, _, owner), result in zip(
            candidates, results if isinstance(results, list) else []
        ):
            self._recover_result(recovered, begin, finish, owner, result, vowels, support)
        return recovered

    def _gaps(self, vowels: Sequence[int]) -> list[tuple[float, float, int | None]]:
        gaps: list[tuple[float, float, int | None]] = list(
            zip(
                [0.0, *(word.end for word in self.words)],
                [*(word.start for word in self.words), len(self.activity) * _STEP],
                [None] * (len(self.words) + 1),
            )
        )
        for index, word in enumerate(self.words):
            text = _key(word.text)
            if (
                text
                and len(set(text)) == 1
                and _character_tokens(text[0])[0] in [[v] for v in vowels]
            ):
                gaps.append(
                    (
                        self.words[index - 1].end if index else 0,
                        self.words[index + 1].start
                        if index + 1 < len(self.words)
                        else len(self.activity) * _STEP,
                        index,
                    )
                )
        return gaps

    def _candidates(
        self, vowels: Sequence[int], support: torch.Tensor
    ) -> list[tuple[float, float, float, float, int | None]]:
        candidates = [
            candidate
            for gap in self._gaps(vowels)
            for candidate in self._gap_candidates(*gap, support)
        ]
        extended = [
            (begin, finish) for begin, finish, _, _, owner in candidates if owner is not None
        ]
        return [
            item
            for item in candidates
            if item[4] is not None
            or not any(begin <= item[0] and item[1] <= finish for begin, finish in extended)
        ]

    def _gap_candidates(
        self,
        left: float,
        right: float,
        owner: int | None,
        support: torch.Tensor,
    ) -> list[tuple[float, float, float, float, int | None]]:
        first, last = max(0, round(left / _STEP)), min(len(self.activity), round(right / _STEP))
        flags = self.activity[first:last] & (self.periodicity[first:last] >= 0.5)
        candidates = []
        for run_first, run_last in _runs(_bridged(flags, round(0.3 / _STEP)), True):
            if (run_last - run_first) * _STEP < 0.8 or flags[run_first:run_last].mean() < 0.6:
                continue
            begin, finish = (first + run_first) * _STEP, (first + run_last) * _STEP
            if owner is not None and not (
                begin < self.words[owner].end
                and self.words[owner].start < finish
                and finish - self.words[owner].end >= 0.3
            ):
                continue
            local = support[round(begin / self.step) : round(finish / self.step)]
            if local.numel() and float(local.max()) >= 0.5:
                context_start = max(left, begin - _MARGIN)
                candidates.append(
                    (
                        begin,
                        finish,
                        context_start,
                        min(right, finish + _MARGIN, context_start + CHUNK_LENGTH),
                        owner,
                    )
                )
        return candidates

    def _recover_result(
        self,
        recovered: list[AlignedWord],
        begin: float,
        finish: float,
        owner: int | None,
        result: Mapping[str, object],
        vowels: Sequence[int],
        support: torch.Tensor,
    ) -> None:
        segments = result.get("segments", [])
        if not isinstance(segments, list):
            return
        segments = [
            segment
            for segment in segments
            if float(segment.get("start", begin)) < finish
            and float(segment.get("end", finish)) > begin
        ]
        recognized = "".join(_key(str(segment.get("text", ""))) for segment in segments)
        for segment in segments:
            text = _key(str(segment.get("text", "")))
            if not text or len(set(text)) != 1:
                continue
            tokens = _character_tokens(text[0])[0]
            if len(tokens) != 1 or tokens[0] not in vowels:
                continue
            span = self._segment_span(
                segment, begin, finish, recognized, text[0], tokens[0], vowels, support
            )
            if span is None:
                continue
            start, end, confidence = span
            if owner is not None:
                if self._extend_vowel(recovered, owner, recognized, text[0], tokens, end):
                    break
                continue
            _append_vowel(recovered, text[0], start, end, confidence)

    def _extend_vowel(
        self,
        recovered: list[AlignedWord],
        owner: int,
        recognized: str,
        text: str,
        tokens: Sequence[int],
        end: float,
    ) -> bool:
        word = self.words[owner]
        if set(recognized) != {text} or _character_tokens(_key(word.text)[0])[0] != tokens:
            return False
        recovered.append(
            replace(
                word,
                end=max(word.end, end),
                letters=_evenly([word.text], word.start, max(word.end, end))[0].letters,
                diagnostics=(
                    *word.diagnostics,
                    "VocalizationRetimed",
                    "ApproximateLetterTiming",
                ),
            )
        )
        return True

    def _segment_span(
        self,
        segment: Mapping[str, float | str],
        begin: float,
        finish: float,
        recognized: str,
        text: str,
        token: int,
        vowels: Sequence[int],
        support: torch.Tensor,
    ) -> tuple[float, float, float] | None:
        start = max(begin, float(segment["start"]) - _MARGIN)
        end = min(finish, float(segment["end"]) + _MARGIN)
        if set(recognized) == {text} and start < end:
            start, end = begin, finish
        local = self.scores[round(start / self.step) : round(end / self.step), token]
        if end - start < 0.8 or not local.numel():
            return None
        confidence = float(local.max().exp())
        vowel = support[round(start / self.step) : round(end / self.step), vowels.index(token)]
        return (start, end, confidence) if float(vowel.max()) >= 0.5 else None


def _append_vowel(
    recovered: list[AlignedWord], text: str, start: float, end: float, confidence: float
) -> None:
    previous = recovered[-1] if recovered else None
    if previous is not None and start < previous.end:
        if previous.text == text.upper():
            recovered[-1] = replace(
                previous, end=max(previous.end, end), score=max(previous.score, confidence)
            )
    else:
        recovered.append(
            AlignedWord(text.upper(), start, end, (start,), confidence, ("RecoveredVocalization",))
        )


@dataclass(frozen=True, slots=True)
class _RepeatRecovery:
    words: list[AlignedWord]
    onsets: Sequence[float]
    acoustic: tuple[np.ndarray, np.ndarray]
    activity: np.ndarray
    levels: np.ndarray
    heard: Mapping[int, tuple[float, float]]

    def _core(self, start: float, end: float) -> np.ndarray:
        harmonic, periodicity = self.acoustic
        first, last = max(0, round(start / _STEP)), min(len(self.activity), round(end / _STEP))
        return harmonic[first:last][self.activity[first:last] & (periodicity[first:last] >= 0.7)]

    def run(self) -> list[AlignedWord]:
        result = list(self.words)
        for _, grouped in groupby(
            range(len(self.words)), key=lambda index: _key(self.words[index].text)
        ):
            indices = list(grouped)
            candidates = self._candidates(indices)
            if candidates is None:
                continue
            entries, reference, negative = candidates
            matches = self._matches(entries, self.words[indices[-1] + 1].start, reference, negative)
            if len(matches) == len(indices):
                for index, (start, end) in zip(indices, matches):
                    result[index] = _retimed_repeat(self.words[index], start, end)
        return result

    def _candidates(self, indices: list[int]) -> tuple[list[float], np.ndarray, np.ndarray] | None:
        first, last = indices[0], indices[-1]
        if (
            len(indices) < 2
            or last + 1 == len(self.words)
            or _timing_load(self.words[first].text)[1] != 1
            or self.words[first].end - self.words[first].start < 0.25
            or any(
                index in self.heard or self.words[index].score > _PREFERENCE for index in indices
            )
        ):
            return None
        following = self.words[last + 1]
        left = max(self.words[first - 1].end if first else 0, self.words[first].start - _MARGIN)
        entries = [entry for entry in self.onsets if left <= entry < following.start]
        if not entries or abs(entries[0] - self.words[first].start) > _MARGIN:
            return None
        reference = self._core(
            entries[0],
            min(self.words[first].end, entries[1] if len(entries) > 1 else following.start),
        )
        negative = self._core(following.start, following.end)
        return (entries, reference, negative) if min(len(reference), len(negative)) >= 10 else None

    def _matches(
        self,
        entries: list[float],
        following: float,
        reference: np.ndarray,
        negative: np.ndarray,
    ) -> list[tuple[float, float]]:
        matches: list[tuple[float, float]] = []
        for start, stop in zip(entries, [*entries[1:], following]):
            features = self._core(start, stop)
            if len(features) < 10:
                continue
            same = max(0.0, float(np.median(1 - (features @ reference.T).max(axis=1))))
            other = max(0.0, float(np.median(1 - (features @ negative.T).max(axis=1))))
            if same > 0.05 or same >= other / 2:
                continue
            matches.extend(self._bounds(start, stop))
        return matches

    def _bounds(self, start: float, stop: float) -> list[tuple[float, float]]:
        periodicity = self.acoustic[1]
        first, last = round(start / _STEP), round(stop / _STEP)
        sounding = (
            self.activity[first:last]
            & (periodicity[first:last] >= 0.5)
            & (self.levels[first:last] >= np.percentile(self.levels[first:last], 95) - 20)
        )
        # Bridge detector flicker while retaining consonant-sized interruptions.
        islands = [(a, b) for a, b in _runs(_bridged(sounding, 2), True) if b - a >= 10]
        if not islands:
            return []
        bounds = [
            float(start),
            *((first + end) * _STEP for _, end in islands[:-1]),
            (first + int(np.flatnonzero(sounding)[-1]) + 1) * _STEP,
        ]
        return list(zip(bounds, bounds[1:]))


def _retimed_repeat(word: AlignedWord, start: float, end: float) -> AlignedWord:
    flags = tuple(
        flag
        for flag in word.diagnostics
        if flag
        not in {
            "TimingReviewRequired",
            "OnsetReviewRequired",
            "BoundaryConflict",
            "BoundaryClipped",
        }
    )
    return replace(
        word,
        start=start,
        end=end,
        letters=_evenly([word.text], start, end)[0].letters,
        diagnostics=(*flags, "AcousticRepeatRetimed", "ApproximateLetterTiming"),
    )
