from __future__ import annotations
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
import numpy as np
import torch
from backend.ai_worker import ctc

from backend.ai_worker.guidance_phrases import (
    _best_phrase_match as _best_phrase_match,
    _character_intervals as _character_intervals,
    _key as _key,
    _matched_positions as _matched_positions,
    _matching_blocks as _matching_blocks,
    _nearby_utterance as _nearby_utterance,
    phrase_window as phrase_window,
    recognized_phrase as recognized_phrase,
)
from backend.ai_worker.guidance_candidates import (
    _boundary_pair as _boundary_pair,
    _bounded_core as _bounded_core,
    _candidates as _candidates,
    _core_candidates as _core_candidates,
    _crosses_confirmed_entry as _crosses_confirmed_entry,
    _following_anchor as _following_anchor,
    _onset_confidence as _onset_confidence,
    _recognized_cores as _recognized_cores,
    _settle_unrecognized_entry as _settle_unrecognized_entry,
    _silent_prefix_entry as _silent_prefix_entry,
    _stable_following_words as _stable_following_words,
    _unrecognized_runs as _unrecognized_runs,
)
from backend.ai_worker.guidance_windows import (
    _coalesce_review_windows as _coalesce_review_windows,
    _review_boundary as _review_boundary,
    _review_context as _review_context,
    _review_stop as _review_stop,
    _review_window as _review_window,
    _review_windows as _review_windows,
    _separate_review_audio as _separate_review_audio,
)
from backend.ai_worker.guidance_review import (
    _active_core_candidates as _active_core_candidates,
    _active_replacement as _active_replacement,
    _active_review_candidates as _active_review_candidates,
    _inactive_core as _inactive_core,
    _preserved_neighbours as _preserved_neighbours,
    _review_anchor_supported as _review_anchor_supported,
    _review_candidates as _review_candidates,
    _review_entries as _review_entries,
    _review_improves as _review_improves,
    _reviewed_words as _reviewed_words,
    _supported_review as _supported_review,
)


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
    onsets: Sequence[float] = (),
    reviewed: frozenset[int] = frozenset(),
    alternatives: Sequence[Sequence[tuple[str, float, float]]] = (),
) -> list[ctc.AlignedWord]:
    if reviewed:
        return _reviewed_words(
            words, scores, frame_seconds, heard, voiced, margin, reviewed, onsets
        )
    pass_ = _GuidancePass(
        words,
        scores,
        frame_seconds,
        heard,
        voiced,
        margin,
        recognized,
        onsets,
        reviewed,
        alternatives,
    )
    result = list(words)
    for window in windows:
        pass_.apply(result, window)
    for index, word in enumerate(result):
        if _silent_prefix_entry(word, scores, frame_seconds, voiced) is None:
            continue
        candidates, recovered = _review_candidates(
            [word],
            scores,
            frame_seconds,
            voiced,
            # CTC's trailing unmatched-audio state needs a frame after the final phoneme.
            ctc.Window(index, index + 1, word.start, word.end + frame_seconds),
            frozenset({index}),
            heard,
            onsets,
        )
        interval = heard.get(index)
        if (
            recovered
            and candidates
            and (
                candidates[0].score > ctc._PREFERENCE
                and (interval is None or interval[0] - margin <= candidates[0].start < interval[1])
            )
        ):
            result[index] = candidates[0]
        elif "OnsetReviewRequired" not in word.diagnostics:
            result[index] = replace(word, diagnostics=(*word.diagnostics, "OnsetReviewRequired"))
    return result


@dataclass(frozen=True, slots=True)
class _GuidancePass:
    words: list[ctc.AlignedWord]
    scores: torch.Tensor
    frame_seconds: float
    heard: Mapping[int, tuple[float, float]]
    voiced: np.ndarray
    margin: float
    recognized: Sequence[tuple[str, float, float]]
    onsets: Sequence[float]
    reviewed: frozenset[int]
    alternatives: Sequence[Sequence[tuple[str, float, float]]] = ()

    def apply(self, result: list[ctc.AlignedWord], window: ctc.Window) -> None:
        phrase, local = max(
            (
                recognized_phrase(
                    window,
                    [word.text for word in self.words[window.first : window.last]],
                    view,
                    self.margin,
                    allow_utterance=window.first - 1 in self.heard and window.last in self.heard,
                )
                for view in (self.recognized, *self.alternatives)
            ),
            key=lambda match: len(match[1]),
        )
        timings = local | dict(self.heard)
        first, last = max(0, window.first - 1), min(len(self.words), window.last + 1)
        options = [[word] for word in result[first:last]]
        alternatives = self._alternatives(window, phrase, timings)
        for index, candidate, interval in alternatives:
            options[index - first].append(candidate)
            timings[index] = interval
        boundary = _boundary_pair(
            result,
            self.scores,
            self.frame_seconds,
            window,
            timings,
            self.voiced,
            self.margin,
            self.onsets,
        )
        if boundary is not None:
            index, before, after = boundary
            options[index - first].append(before)
            options[index + 1 - first].append(after)
        result[first:last] = _select_sequence(
            result[first:last],
            options,
            timings,
            first,
            self.voiced,
            margin=self.margin,
            boundary=boundary,
        )
        for index in range(max(1, window.first), window.last):
            preceding, current = timings.get(index - 1), timings.get(index)
            word = result[index]
            if (
                preceding is not None
                and current is not None
                and current[0] - preceding[1] >= ctc._SILENCE_ENDS_WORD_SECONDS
                and any(
                    max(preceding[1], word.start - self.margin)
                    <= onset
                    <= min(current[1], word.start + self.margin)
                    for onset in self.onsets
                )
                and "RecognizedPhraseEntry" not in word.diagnostics
            ):
                result[index] = replace(
                    word, diagnostics=(*word.diagnostics, "RecognizedPhraseEntry")
                )

    def _alternatives(
        self,
        window: ctc.Window,
        phrase: ctc.Window | None,
        timings: dict[int, tuple[float, float]],
    ) -> list[tuple[int, ctc.AlignedWord, tuple[float, float]]]:
        alternatives = _recognized_cores(
            self.words,
            self.scores,
            self.frame_seconds,
            window,
            timings,
            self.voiced,
            self.margin,
            self.onsets,
            self.reviewed,
        )
        if phrase is not None or any(window.first <= index < window.last for index in timings):
            # An unrecognized neighbour can occupy an earlier recognized word's real place.
            # Refit that gap between heard anchors too, so the joint choice can move both.
            alternatives += _unrecognized_runs(
                self.words, self.scores, self.frame_seconds, phrase or window, timings, self.voiced
            )
        return alternatives


def _select_sequence(
    original: list[ctc.AlignedWord],
    options: Sequence[Sequence[ctc.AlignedWord]],
    heard: Mapping[int, tuple[float, float]],
    first: int,
    voiced: np.ndarray,
    *,
    margin: float = 0.6,
    boundary: tuple[int, ctc.AlignedWord, ctc.AlignedWord] | None = None,
) -> list[ctc.AlignedWord]:
    """Choose word cores jointly; an improvement cannot crush or reverse a neighbour."""
    baseline = ctc.ordered(original)
    states: list[tuple[float, float, list[ctc.AlignedWord]]] = [(0.0, 0.0, [])]
    for index, choices in enumerate(options):
        following: list[tuple[float, float, list[ctc.AlignedWord]]] = []
        interval = heard.get(first + index)
        for word in choices:
            distance = _recognition_distance(word, interval, margin)
            paths = [
                (cost + distance, confidence - word.score, [*path, word])
                for cost, confidence, path in states
                if not path or _compatible(path[-1], word, baseline[index - 1], voiced)
                if boundary is None
                or first + index != boundary[0] + 1
                or (path[-1] == boundary[1]) == (word == boundary[2])
            ]
            if paths:
                following.append(min(paths, key=lambda item: item[:2]))
        states = following
    return min(states, key=lambda item: item[:2])[2] if states else original


def _recognition_distance(
    word: ctc.AlignedWord, interval: tuple[float, float] | None, margin: float
) -> float:
    if interval is None:
        return 0.0
    # Word spans can include the previous vowel or silence. Keep the existing
    # recognition margin, but do not let a wide span hide an arbitrarily late onset.
    onset = max(0.0, interval[0] - word.start, round(word.start - interval[0] - margin, 6))
    return onset + max(0.0, interval[0] - word.end, word.end - interval[1])


def _compatible(
    left: ctc.AlignedWord,
    right: ctc.AlignedWord,
    original: ctc.AlignedWord,
    voiced: np.ndarray,
) -> bool:
    return left.start < right.start and ctc._implausible(
        [ctc.ordered([left, right])[0]], voiced
    ) <= ctc._implausible([original], voiced)
