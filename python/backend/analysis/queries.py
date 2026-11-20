from __future__ import annotations

from dataclasses import replace
import math
from typing import Mapping, Sequence

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.persistence import UnitOfWorkFactory
from backend.recordings.domain import Recording
from backend.version import ANALYSIS_ALGORITHM_VERSION


def _current(result: AnalysisResult, reference: tuple[str, int] | None) -> AnalysisResult:
    """A take is assessed against its recorded reference, even after editing the song."""
    outdated = (
        reference != (result.song_id, result.song_revision)
        or result.algorithm_version != ANALYSIS_ALGORITHM_VERSION
    )
    if outdated and result.state is AnalysisState.SUCCEEDED:
        return replace(result, state=AnalysisState.STALE)
    return result


class ListRecordingAnalyses:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, recording_id: str) -> Sequence[AnalysisResult]:
        reference = None
        with self._uow.create() as transaction:
            results = transaction.analyses.list_for_recording(recording_id)
            recording = transaction.recordings.get(recording_id)
            live = live_result(recording) if recording else None
            if live:
                results = [*results, live]
            if (
                recording is not None
                and recording.song_id is not None
                and recording.song_revision is not None
                and transaction.songs.get(recording.song_id) is not None
            ):
                reference = (recording.song_id, recording.song_revision)
        return [_current(result, reference) for result in results]


def live_result(recording: Recording) -> AnalysisResult | None:
    """The measurements collected while singing are immediately available, without another AI pass."""
    score = (recording.session_metadata or {}).get("karaokeNoteScore")
    values = _live_metrics(score)
    if values is None or recording.song_id is None or recording.song_revision is None:
        return None
    assert isinstance(score, Mapping)
    uncertain = float(score["assessedPitchSeconds"]) < float(score["expectedPitchSeconds"]) * 0.25
    return AnalysisResult(
        f"live-{recording.recording_id}",
        recording.recording_id,
        recording.song_id,
        recording.song_revision,
        ANALYSIS_ALGORITHM_VERSION,
        AnalysisState.FAILED if uncertain else AnalysisState.SUCCEEDED,
        recording.created_at,
        recording.created_at,
        f"live-{recording.recording_id}",
        *values,
        error={
            "code": "AnalysisPitchUncertain",
            "message": "Too little reliable microphone pitch evidence",
        }
        if uncertain
        else None,
    )


def _live_metrics(score: object) -> tuple[float, float, float, float] | None:
    if not isinstance(score, Mapping) or score.get("version") != 3:
        return None
    fields = (
        "pitchAccuracyPercent",
        "meanSemitoneDeviation",
        "rhythmAccuracyPercent",
        "noteStabilityPercent",
    )
    values: list[float] = []
    for key in fields:
        value = score.get(key)
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
        ):
            return None
        values.append(float(value))
    pitch, deviation, rhythm, stability = values
    expected, assessed = score.get("expectedPitchSeconds"), score.get("assessedPitchSeconds")
    if any(
        not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value)
        for value in (expected, assessed)
    ):
        return None
    assert isinstance(expected, (int, float)) and isinstance(assessed, (int, float))
    total, hits = score.get("totalNotes"), score.get("hitNotes")
    if (
        max(pitch, rhythm, stability) > 100
        or not isinstance(total, int)
        or not isinstance(hits, int)
        or not 0 <= hits <= total
        or expected <= 0
        or not 0 <= assessed <= expected + 1e-6
        or (total == 0 and assessed > 0)
    ):
        return None
    return pitch, deviation, rhythm, stability
