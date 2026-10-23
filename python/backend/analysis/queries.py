from __future__ import annotations

from dataclasses import replace
from typing import Sequence

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.persistence import UnitOfWorkFactory
from backend.version import ANALYSIS_ALGORITHM_VERSION


def _current(result: AnalysisResult, active_revision: int | None) -> AnalysisResult:
    """Retain historical results without presenting an obsolete score as current."""
    outdated = (
        active_revision != result.song_revision
        or result.algorithm_version != ANALYSIS_ALGORITHM_VERSION
    )
    if outdated and result.state is AnalysisState.SUCCEEDED:
        return replace(result, state=AnalysisState.STALE)
    return result


class ListRecordingAnalyses:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, recording_id: str) -> Sequence[AnalysisResult]:
        with self._uow.create() as transaction:
            results = transaction.analyses.list_for_recording(recording_id)
            revisions: dict[str, int | None] = {}
            for result in results:
                if result.song_id not in revisions:
                    song = transaction.songs.get(result.song_id)
                    revisions[result.song_id] = song.active_revision if song else None
        return [_current(result, revisions[result.song_id]) for result in results]
