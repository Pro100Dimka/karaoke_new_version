from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Annotated, Mapping

from fastapi import APIRouter, Depends, Header, Query, Response
from pydantic import Field

from backend.analysis.domain import AnalysisResult
from backend.api.base_dto import ApiModel, JobRefDto
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.recordings.domain import Recording
from backend.recordings.register_recording import RegisterRecordingRequest

router = APIRouter(prefix="/recordings")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class RecordingTargetDto(ApiModel):
    recording_id: str
    file_path: str


class RegisterRecordingDto(ApiModel):
    recording_id: str = Field(min_length=1, max_length=128)
    file_path: str = Field(min_length=1, max_length=4096)
    duration: float = Field(gt=0)
    sample_rate: int = Field(gt=0, le=384000)
    channels: int = Field(gt=0, le=32)
    created_at: datetime
    song_id: str | None = None
    song_revision: int | None = Field(default=None, ge=1)
    gaps: list[dict[str, float]] = Field(default_factory=list)
    session_metadata: dict[str, object] = Field(default_factory=dict)


class RecordingDto(ApiModel):
    recording_id: str
    file_path: str
    duration: float
    sample_rate: int
    channels: int
    created_at: datetime
    song_id: str | None
    song_revision: int | None


class RecordingPageDto(ApiModel):
    items: list[RecordingDto]
    total: int
    limit: int
    offset: int


class AnalysisDto(ApiModel):
    analysis_id: str
    recording_id: str
    song_id: str
    song_revision: int
    algorithm_version: str
    state: str
    pitch_accuracy_percent: float | None
    mean_semitone_deviation: float | None
    problem_regions: list[Mapping[str, float]]
    error: Mapping[str, object] | None


@router.post("/target", response_model=RecordingTargetDto)
def allocate_target(app: ContainerDep) -> RecordingTargetDto:
    target = app.recordings.allocate.execute()
    return RecordingTargetDto(recording_id=target.recording_id, file_path=str(target.file_path))


@router.post("", response_model=RecordingDto, status_code=201)
def register_recording(
    body: RegisterRecordingDto,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> RecordingDto:
    request = RegisterRecordingRequest(
        recording_id=body.recording_id,
        file_path=Path(body.file_path),
        duration=body.duration,
        sample_rate=body.sample_rate,
        channels=body.channels,
        created_at=body.created_at,
        song_id=body.song_id,
        song_revision=body.song_revision,
        gaps=tuple(body.gaps),
        session_metadata=body.session_metadata,
        idempotency_key=idempotency_key,
    )
    return _recording(app.recordings.register.execute(request))


@router.get("", response_model=RecordingPageDto)
def list_recordings(
    app: ContainerDep,
    song_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RecordingPageDto:
    page = app.recordings.list.execute(song_id=song_id, limit=limit, offset=offset)
    return RecordingPageDto(
        items=[_recording(item) for item in page.items],
        total=page.total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/{recording_id}", response_model=RecordingDto)
def get_recording(recording_id: str, app: ContainerDep) -> RecordingDto:
    return _recording(app.recordings.get.execute(recording_id))


@router.delete("/{recording_id}", status_code=204)
def delete_recording(recording_id: str, app: ContainerDep) -> Response:
    app.recordings.delete.execute(recording_id)
    return Response(status_code=204)


@router.post("/{recording_id}/analysis", response_model=JobRefDto, status_code=202)
def analyze_recording(recording_id: str, app: ContainerDep) -> JobRefDto:
    job = app.recordings.start_analysis.execute(recording_id)
    return JobRefDto(job_id=job.job_id, state=job.state.value)


@router.get("/{recording_id}/analyses", response_model=list[AnalysisDto])
def list_analyses(recording_id: str, app: ContainerDep) -> list[AnalysisDto]:
    return [_analysis(item) for item in app.recordings.list_analyses.execute(recording_id)]


@router.get("/analysis/{analysis_id}", response_model=AnalysisDto)
def get_analysis(analysis_id: str, app: ContainerDep) -> AnalysisDto:
    return _analysis(app.recordings.get_analysis.execute(analysis_id))


def _recording(recording: Recording) -> RecordingDto:
    return RecordingDto(
        recording_id=recording.recording_id,
        file_path=str(recording.file_path),
        duration=recording.duration,
        sample_rate=recording.sample_rate,
        channels=recording.channels,
        created_at=recording.created_at,
        song_id=recording.song_id,
        song_revision=recording.song_revision,
    )


def _analysis(result: AnalysisResult) -> AnalysisDto:
    return AnalysisDto(
        analysis_id=result.analysis_id,
        recording_id=result.recording_id,
        song_id=result.song_id,
        song_revision=result.song_revision,
        algorithm_version=result.algorithm_version,
        state=result.state.value,
        pitch_accuracy_percent=result.pitch_accuracy_percent,
        mean_semitone_deviation=result.mean_semitone_deviation,
        problem_regions=[dict(item) for item in result.problem_regions],
        error=result.error,
    )
