from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.analysis.domain import AnalysisResult, AnalysisState, SectionResult
from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import AnalysisRow
from backend.serialization import dumps, loads_list, loads_object


def _sections(raw: str) -> tuple[SectionResult, ...]:
    values = loads_list(raw)
    return tuple(
        SectionResult(
            start=float(item["start"]),
            end=float(item["end"]),
            pitch_accuracy_percent=float(item["pitch_accuracy_percent"]),
            mean_semitone_deviation=float(item["mean_semitone_deviation"]),
        )
        for item in values
        if isinstance(item, dict)
    )


def _to_domain(row: AnalysisRow) -> AnalysisResult:
    regions_raw = loads_list(row.problem_regions_json)
    regions = tuple(dict(item) for item in regions_raw if isinstance(item, dict))
    error = dict(loads_object(row.error_json)) if row.error_json else None
    return AnalysisResult(
        analysis_id=row.analysis_id,
        recording_id=row.recording_id,
        song_id=row.song_id,
        song_revision=row.song_revision,
        algorithm_version=row.algorithm_version,
        recording_identity=row.recording_identity,
        state=AnalysisState(row.state),
        pitch_accuracy_percent=row.pitch_accuracy_percent,
        mean_semitone_deviation=row.mean_semitone_deviation,
        section_results=_sections(row.section_results_json),
        problem_regions=regions,
        error=error,
        created_at=as_utc(row.created_at),
        updated_at=as_utc(row.updated_at),
    )


def _apply(row: AnalysisRow, result: AnalysisResult) -> None:
    row.recording_id = result.recording_id
    row.song_id = result.song_id
    row.song_revision = result.song_revision
    row.algorithm_version = result.algorithm_version
    row.recording_identity = result.recording_identity
    row.state = result.state.value
    row.pitch_accuracy_percent = result.pitch_accuracy_percent
    row.mean_semitone_deviation = result.mean_semitone_deviation
    row.section_results_json = dumps(result.section_results)
    row.problem_regions_json = dumps(result.problem_regions)
    row.error_json = dumps(result.error) if result.error else None
    row.created_at = result.created_at
    row.updated_at = result.updated_at


class SqlAnalysisRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, analysis_id: str) -> AnalysisResult | None:
        row = self._session.scalar(
            select(AnalysisRow).where(AnalysisRow.analysis_id == analysis_id)
        )
        return _to_domain(row) if row else None

    def add(self, result: AnalysisResult) -> None:
        row = AnalysisRow(analysis_id=result.analysis_id)
        _apply(row, result)
        self._session.add(row)

    def update(self, result: AnalysisResult) -> None:
        row = self._session.scalar(
            select(AnalysisRow).where(AnalysisRow.analysis_id == result.analysis_id)
        )
        if row is None:
            raise KeyError(result.analysis_id)
        _apply(row, result)

    def list_for_recording(self, recording_id: str) -> Sequence[AnalysisResult]:
        query = select(AnalysisRow).where(AnalysisRow.recording_id == recording_id)
        query = query.order_by(AnalysisRow.created_at.desc(), AnalysisRow.analysis_id)
        return [_to_domain(row) for row in self._session.scalars(query).all()]
