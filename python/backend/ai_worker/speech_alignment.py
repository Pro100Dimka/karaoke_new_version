from __future__ import annotations
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import partial
import numpy as np
import torch
from backend.ai_worker.acoustic_retry import recover_compressed_cues, recover_weak_cue_entries
from backend.ai_worker.ctc_bounds import _preserved_onset_letters as _preserved_onset_letters
from backend.ai_worker.ctc import (
    AlignedWord,
    _LARGEST_LAG_SECONDS,
    Window,
    align_guided,
    align_words,
    ordered,
    with_sung_ends,
    with_sung_letters,
    with_voice_onsets,
)
from backend.ai_worker.timing import (
    audible_frames,
    _levels,
    harmonic_evidence,
    singing_frames,
    vocal_onsets,
    voiced_frames,
)
from backend.ai_worker.recognition import (
    HeardWord,
    alignment_payload,
    boundary_conflicts,
    guidance_positions,
    contextual_guidance,
    independent_timings,
    recover_leading_words,
    recover_vocalizations,
    with_acoustic_repeats,
    with_lead_vocals,
    heard_timings as _heard_timings,
    rate_review_indices,
)
from backend.ai_worker.word_guidance import with_word_guidance
from backend.ai_worker.vocal_recovery import replace_displaced_outro
from backend.ai_worker.speech_windows import (
    _HOP as _HOP,
    _MARGIN_SECONDS as _MARGIN_SECONDS,
    _MINIMUM_BLOCK as _MINIMUM_BLOCK,
    _SAMPLE_RATE as _SAMPLE_RATE,
    _alignment_windows as _alignment_windows,
    _line_first_words,
)


@dataclass(slots=True)
class _AlignmentPass:
    audio: np.ndarray
    backing: np.ndarray | None
    scores: torch.Tensor
    step: float
    words: list[str]
    lyrics: str
    heard: list[HeardWord]
    views: list[list[HeardWord]]
    emit: Callable[[np.ndarray], tuple[torch.Tensor, float]] | None = None

    def run(
        self,
        timing_hints: Sequence[Mapping[str, object]],
        recognize: partial[Mapping[str, object]],
    ) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
        whole = align_words(self.scores, self.step, self.words)
        self.heard = recover_leading_words(self.lyrics, whole, self.heard, recognize)
        guided, guide, voiced, activity, supported = self._guide_alignment(
            timing_hints, whole, recognize
        )
        return self._refine_alignment(supported, guided, guide, voiced, activity, recognize)

    def _guide_alignment(
        self,
        timing_hints: Sequence[Mapping[str, object]],
        whole: list[AlignedWord],
        recognize: partial[Mapping[str, object]],
    ) -> tuple[
        list[AlignedWord],
        partial[list[AlignedWord]],
        np.ndarray,
        np.ndarray,
        dict[int, tuple[float, float]],
    ]:
        windows = _alignment_windows(self.lyrics, timing_hints, self.heard, whole, self.audio)
        windows, supported = contextual_guidance(
            self.words,
            windows,
            whole,
            _heard_timings(
                self.words, self.heard, whole, minimum_block=_MINIMUM_BLOCK, windows=windows
            ),
            activity := singing_frames(self.audio, self.backing, _SAMPLE_RATE, _HOP),
            recognize,
        )
        positions = guidance_positions(
            _heard_timings(self.words, self.heard, whole, windows=windows) | supported, windows
        )
        guided, guide, voiced = self._guided_words(windows, supported, whole, positions)
        if self.emit is not None and timing_hints:
            cues = _line_first_words(self.words, timing_hints)
            guided = recover_compressed_cues(guided, cues, self._fit_voice)
            guided = recover_weak_cue_entries(
                guided,
                cues,
                vocal_onsets(self.audio, _SAMPLE_RATE, _HOP).tolist(),
                self._fit_voice,
            )
        return guided, guide, voiced, activity, supported

    def _guided_words(
        self,
        windows: Sequence[Window],
        supported: dict[int, tuple[float, float]],
        whole: list[AlignedWord],
        positions: Mapping[int, float],
    ) -> tuple[list[AlignedWord], partial[list[AlignedWord]], np.ndarray]:
        voiced = voiced_frames(self.audio, _SAMPLE_RATE, _HOP)
        guide = partial(
            with_word_guidance,
            scores=self.scores,
            frame_seconds=self.step,
            windows=windows,
            heard=supported,
            voiced=voiced,
            margin=_MARGIN_SECONDS,
            recognized=self.heard,
            alternatives=self.views,
            onsets=vocal_onsets(self.audio, _SAMPLE_RATE, _HOP).tolist(),
        )
        guided = guide(
            align_guided(
                self.scores,
                self.step,
                self.words,
                windows,
                positions,
                voiced,
                whole,
                anchors={index: positions[index] for index in supported},
                # Fuzzy character support cannot establish ownership of a repeated word run.
                spans=_heard_timings(self.words, self.heard, whole, minimum_block=_MINIMUM_BLOCK),
            )
        )
        return guided, guide, voiced

    def _refine_alignment(
        self,
        supported: dict[int, tuple[float, float]],
        guided: list[AlignedWord],
        guide: partial[list[AlignedWord]],
        voiced: np.ndarray,
        activity: np.ndarray,
        recognize: partial[Mapping[str, object]],
    ) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
        acoustic = harmonic_evidence(self.audio, _SAMPLE_RATE, _HOP)
        harmonics = acoustic if self.backing is not None else None
        audible = audible_frames(self.audio, _HOP)
        started = with_voice_onsets(
            guided,
            self.audio,
            voiced,
            supported | independent_timings(self.words, [self.heard, *self.views], guided),
        )

        def sung_ends(values: list[AlignedWord]) -> list[AlignedWord]:
            return with_sung_ends(
                values, self.audio, self.backing, activity, harmonics, audible, acoustic[1]
            )

        timed = ordered(sung_ends(started))
        intervals = supported | independent_timings(self.words, [self.heard, *self.views], timed)
        reviewed = rate_review_indices(timed, self.lyrics, heard=intervals, activity=activity)
        reviewed |= boundary_conflicts(guided)
        timed, recovered = self._recover_alignment(
            guided, started, timed, reviewed, intervals, guide, activity, voiced, sung_ends
        )
        return self._finish_alignment(timed, activity, acoustic, recognize, recovered, intervals)

    def _finish_alignment(
        self,
        timed: list[AlignedWord],
        activity: np.ndarray,
        acoustic: tuple[np.ndarray, np.ndarray],
        recognize: partial[Mapping[str, object]],
        recovered: frozenset[int],
        intervals: Mapping[int, tuple[float, float]],
    ) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
        timed = with_sung_letters(timed, self.scores, self.step, activity, intervals)
        timed = with_acoustic_repeats(
            timed,
            vocal_onsets(self.audio, _SAMPLE_RATE, _HOP).tolist(),
            acoustic,
            activity,
            _levels(self.audio, _HOP)[0],
            independent_timings(self.words, [self.heard, *self.views], timed),
        )
        timed = with_lead_vocals(
            timed,
            self.views,
            activity,
            acoustic[1],
            recognize=recognize,
            refine=partial(self._refine_recovered_entries, activity=activity),
        )
        timed, intervals, recovered = self._retime_outro(timed, activity, intervals, recovered)
        return self._vocalization_payload(
            timed, activity, acoustic[1], recognize, recovered, intervals
        )

    def _refine_recovered_entries(
        self, words: list[AlignedWord], activity: np.ndarray
    ) -> list[AlignedWord]:
        result = list(words)
        for index, word in enumerate(words):
            if "IndependentLeadEntry" not in word.diagnostics:
                continue
            context = words[index : index + 3]
            candidate = self._fit_voice(
                [item.text for item in context], word.start, context[-1].end
            )
            if len(candidate) != len(context):
                continue
            candidate = with_voice_onsets(candidate, self.audio, activity)
            if any(
                before.text != after.text or abs(before.start - after.start) > _LARGEST_LAG_SECONDS
                for before, after in zip(context[1:], candidate[1:], strict=True)
            ):
                continue
            head = candidate[0]
            if (
                head.text == word.text
                and head.score >= 0.1
                and word.start <= head.start < head.end <= word.end
            ):
                result[index] = replace(
                    head,
                    end=word.end,
                    diagnostics=tuple(dict.fromkeys((*word.diagnostics, *head.diagnostics))),
                )
        return result

    def _retime_outro(
        self,
        original: list[AlignedWord],
        activity: np.ndarray,
        intervals: Mapping[int, tuple[float, float]],
        recovered: frozenset[int],
    ) -> tuple[list[AlignedWord], Mapping[int, tuple[float, float]], frozenset[int]]:
        timed, displaced = (
            replace_displaced_outro(original, self.lyrics, activity, intervals, self._fit_voice)
            if self.emit is not None
            else (original, None)
        )
        intervals = {
            **intervals,
            **independent_timings(self.words, [self.heard, *self.views], original),
        }
        if displaced is None:
            return timed, intervals, recovered
        first, stop = displaced
        indices = {
            index: index if index < first else index - (stop - first)
            for index in range(len(original))
            if not first <= index < stop
        }
        return (
            timed,
            {indices[index]: span for index, span in intervals.items() if index in indices},
            frozenset(indices[index] for index in recovered if index in indices),
        )

    def _fit_voice(self, words: list[str], start: float, end: float) -> list[AlignedWord]:
        if self.emit is None:
            return []
        first, last = round(start * _SAMPLE_RATE), round(end * _SAMPLE_RATE)
        try:
            scores, step = self.emit(self.audio[first:last])
            return align_words(scores, step, words, first / _SAMPLE_RATE)
        except (ValueError, OSError, RuntimeError):
            return []

    def _vocalization_payload(
        self,
        timed: list[AlignedWord],
        activity: np.ndarray,
        periodicity: np.ndarray,
        recognize: partial[Mapping[str, object]],
        recovered: frozenset[int],
        intervals: Mapping[int, tuple[float, float]],
    ) -> dict[str, list[dict[str, float | str | list[float] | list[str]]]]:
        vowels = recover_vocalizations(
            timed, self.scores, self.step, activity, periodicity, recognize
        )
        extended = {
            (word.start, word.text): word
            for word in vowels
            if "VocalizationRetimed" in word.diagnostics
        }
        timed = [extended.get((word.start, word.text), word) for word in timed]
        recovered_vowels = [word for word in vowels if "RecoveredVocalization" in word.diagnostics]
        payload = alignment_payload(
            timed,
            intervals,
            recovered=recovered,
            reviewed=frozenset(
                rate_review_indices(timed, self.lyrics, heard=intervals, activity=activity)
            ),
        )
        payload["words"].extend(alignment_payload(recovered_vowels, {})["words"])
        entries = [word.start for word in timed]
        for index in range(len(timed) - 2, -1, -1):
            if "BackingVocalOverlap" in timed[index].diagnostics:
                entries[index] = entries[index + 1]
        payload["words"] = [
            value
            for _, value in sorted(
                zip([*entries, *(word.start for word in recovered_vowels)], payload["words"]),
                key=lambda pair: pair[0],
            )
        ]
        return payload

    def _recover_alignment(
        self,
        guided: list[AlignedWord],
        started: list[AlignedWord],
        timed: list[AlignedWord],
        reviewed: set[int],
        intervals: Mapping[int, tuple[float, float]],
        guide: partial[list[AlignedWord]],
        activity: np.ndarray,
        voiced: np.ndarray,
        sung_ends: Callable[[list[AlignedWord]], list[AlignedWord]],
    ) -> tuple[list[AlignedWord], frozenset[int]]:
        recovered: frozenset[int] = frozenset()
        if reviewed:
            cores = guide(guided, heard=intervals, voiced=activity, reviewed=frozenset(reviewed))
            if cores != guided:
                adjusted = with_voice_onsets(cores, self.audio, voiced)
                # Recalibrating one onset must not shift distant unchanged cores. Keep
                # jointly accepted neighbours, then recompute the affected preceding ends.
                local = [
                    _preserved_onset_letters(guided[i], cores[i], started[i], word)
                    if cores[i] != guided[i]
                    else started[i]
                    for i, word in enumerate(adjusted)
                ]
                repaired = ordered(sung_ends(local))
                # Commit the accepted sequence together: restoring its old neighbour cuts it again.
                recovered = frozenset(i for i, word in enumerate(repaired) if word != timed[i])
                timed = repaired
        return timed, recovered
