from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.analysis.domain import AnalysisResult, AnalysisState, AnalysisSummary, SectionResult
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
    error = loads_object(row.error_json) if row.error_json else None
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
        rhythm_accuracy_percent=row.rhythm_accuracy_percent,
        note_stability_percent=row.note_stability_percent,
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
    row.rhythm_accuracy_percent = result.rhythm_accuracy_percent
    row.note_stability_percent = result.note_stability_percent
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

    def list_unfinished(self) -> Sequence[AnalysisResult]:
        query = select(AnalysisRow).where(
            AnalysisRow.state.in_((AnalysisState.QUEUED.value, AnalysisState.RUNNING.value))
        )
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def latest_summaries(self, recording_ids: Sequence[str]) -> dict[str, AnalysisSummary]:
        if not recording_ids:
            return {}
        latest = (
            select(
                AnalysisRow.recording_id,
                AnalysisRow.song_id,
                AnalysisRow.song_revision,
                AnalysisRow.algorithm_version,
                AnalysisRow.state,
                func.row_number()
                .over(
                    partition_by=AnalysisRow.recording_id,
                    order_by=(AnalysisRow.created_at.desc(), AnalysisRow.analysis_id),
                )
                .label("position"),
            )
            .where(AnalysisRow.recording_id.in_(recording_ids))
            .subquery()
        )
        return {
            row.recording_id: AnalysisSummary(
                row.song_id, row.song_revision, row.algorithm_version, AnalysisState(row.state)
            )
            for row in self._session.execute(select(latest).where(latest.c.position == 1))
        }
