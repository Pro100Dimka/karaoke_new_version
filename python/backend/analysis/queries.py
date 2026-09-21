from __future__ import annotations

from dataclasses import replace
from typing import Sequence

from backend.analysis.domain import AnalysisResult, AnalysisState
from backend.domain_errors import NotFoundError
from backend.persistence import UnitOfWorkFactory


class GetAnalysis:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, analysis_id: str) -> AnalysisResult:
        with self._uow.create() as transaction:
            result = transaction.analyses.get(analysis_id)
            song = transaction.songs.get(result.song_id) if result else None
        if result is None:
            raise NotFoundError("AnalysisNotFound", "Analysis result was not found")
        if (
            song
            and song.active_revision != result.song_revision
            and result.state is AnalysisState.SUCCEEDED
        ):
            return replace(result, state=AnalysisState.STALE)
        return result


class ListRecordingAnalyses:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, recording_id: str) -> Sequence[AnalysisResult]:
        with self._uow.create() as transaction:
            return transaction.analyses.list_for_recording(recording_id)
