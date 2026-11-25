from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Annotated, Literal, Mapping

from fastapi import APIRouter, Depends, Header, Query, Response
from pydantic import Field, ValidationError

from backend.analysis.domain import AnalysisResult
from backend.api.base_dto import ApiModel, JobRefDto
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.domain_errors import ConflictError, NotFoundError
from backend.infrastructure.paths import ensure_within
from backend.recordings.domain import Recording, validate_recording_id
from backend.recordings.register_recording import RegisterRecordingRequest
from backend.recordings.room_sources import (
    complete_room_sources,
    export_room_source,
    import_room_source,
    initialize_room_sources,
    room_source_state,
)

router = APIRouter(prefix="/recordings")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class RecordingTargetDto(ApiModel):
    recording_id: str
    file_path: str


class RecordingContextDto(ApiModel):
    song_id: str | None = Field(default=None, max_length=64)
    song_revision: int | None = Field(default=None, ge=1)


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


class RoomPerformanceDto(ApiModel):
    room_id: str = Field(min_length=1, max_length=128)
    performance_id: int = Field(ge=0)
    overall_score: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    status: Literal["pending", "complete", "unavailable"] | None = None


class RecordingDto(ApiModel):
    room_performance: RoomPerformanceDto | None = None
    room_sources: dict[str, object] | None = None
    recording_id: str
    file_path: str
    duration: float
    sample_rate: int
    channels: int
    created_at: datetime
    song_id: str | None
    song_revision: int | None
    display_name: str | None
    file_status: str
    analysis_status: str
    source_recording_id: str | None
    size_bytes: int


class UpdateRecordingDto(ApiModel):
    display_name: str | None = Field(default=None, max_length=300)
    room_performance: RoomPerformanceDto | None = None


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
    rhythm_accuracy_percent: float | None
    note_stability_percent: float | None
    problem_regions: list[Mapping[str, float]]
    error: Mapping[str, object] | None


@router.post("/target", response_model=RecordingTargetDto)
def allocate_target(
    app: ContainerDep, body: RecordingContextDto | None = None
) -> RecordingTargetDto:
    target = app.recordings.allocate(
        body.song_id if body else None,
        body.song_revision if body else None,
    )
    return RecordingTargetDto(recording_id=target.recording_id, file_path=str(target.file_path))


@router.post("/{recording_id}/recover", status_code=204)
def recover_recording(recording_id: str, app: ContainerDep) -> Response:
    app.recordings.reconcile.execute(validate_recording_id(recording_id))
    return Response(status_code=204)


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
    recording = app.recordings.register.execute(request)
    initialize_room_sources(recording)
    return _recording(app, recording)


class RoomSourceDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)


class ImportRoomSourceDto(RoomSourceDto):
    file_path: str = Field(min_length=1, max_length=4096)


class CompleteRoomSourcesDto(ApiModel):
    participants: dict[str, list[str] | None] = Field(default_factory=dict, max_length=64)
    failure: str | None = Field(default=None, max_length=500)


@router.post("/{recording_id}/room-source")
def export_singer_source(
    recording_id: str, body: RoomSourceDto, app: ContainerDep
) -> dict[str, str]:
    recording = app.recordings.get.execute(validate_recording_id(recording_id))
    return {"filePath": str(export_room_source(recording, body.participant_id))}


@router.post("/{recording_id}/room-source/import")
def import_singer_source(
    recording_id: str, body: ImportRoomSourceDto, app: ContainerDep
) -> dict[str, str]:
    recording = app.recordings.get.execute(validate_recording_id(recording_id))
    bundle = ensure_within(Path(body.file_path), app.roots.app)
    directory = import_room_source(recording, body.participant_id, bundle)
    return {"directory": directory.name}


@router.post("/{recording_id}/room-sources")
def finish_singer_sources(
    recording_id: str, body: CompleteRoomSourcesDto, app: ContainerDep
) -> dict[str, object]:
    recording = app.recordings.get.execute(validate_recording_id(recording_id))
    return complete_room_sources(recording, body.participants, failure=body.failure)


@router.get("", response_model=RecordingPageDto)
def list_recordings(
    app: ContainerDep,
    song_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0,
) -> RecordingPageDto:
    page = app.recordings.list.execute(song_id=song_id, limit=limit, offset=offset)
    statuses = app.recordings.list_analyses.statuses(page.items)
    sources = app.recordings.get.many(
        list(
            {
                source_id
                for item in page.items
                if (source_id := _source_recording_id(item)) and _room_performance(item) is not None
            }
        )
    )
    return RecordingPageDto(
        items=[
            _recording(app, item, analysis_status=statuses[item.recording_id], sources=sources)
            for item in page.items
        ],
        total=page.total,
        limit=page.limit,
        offset=page.offset,
    )


@router.get("/{recording_id}", response_model=RecordingDto)
def get_recording(recording_id: str, app: ContainerDep) -> RecordingDto:
    return _recording(app, app.recordings.get.execute(recording_id))


@router.patch("/{recording_id}", response_model=RecordingDto)
def update_recording(
    recording_id: str, body: UpdateRecordingDto, app: ContainerDep
) -> RecordingDto:
    if body.room_performance is not None:
        return _recording(
            app,
            app.recordings.update.room_result(
                recording_id, body.room_performance.model_dump(by_alias=True, exclude_none=True)
            ),
        )
    return _recording(app, app.recordings.update.execute(recording_id, body.display_name))


@router.delete("/{recording_id}", status_code=204)
def delete_recording(
    recording_id: str, app: ContainerDep, discard_silent: bool = False
) -> Response:
    app.system.jobs.run_when_idle(
        lambda: app.recordings.delete.execute(recording_id, discard_silent=discard_silent),
        busy_error=ConflictError(
            "LibraryInUse", "Wait for background jobs before deleting recordings"
        ),
    )
    return Response(status_code=204)


@router.post("/{recording_id}/prepare", response_model=RecordingDto)
def prepare_recording(recording_id: str, app: ContainerDep) -> RecordingDto:
    return _recording(app, app.recordings.register.retry(recording_id))


@router.post("/{recording_id}/analysis", response_model=JobRefDto, status_code=202)
def analyze_recording(recording_id: str, app: ContainerDep) -> JobRefDto:
    job = app.recordings.start_analysis.execute(recording_id)
    return JobRefDto(job_id=job.job_id, state=job.state.value)


@router.post("/{recording_id}/studio-master", response_model=JobRefDto, status_code=202)
def create_studio_master(recording_id: str, app: ContainerDep) -> JobRefDto:
    job = app.recordings.start_studio_master.execute(recording_id)
    return JobRefDto(job_id=job.job_id, state=job.state.value)


@router.get("/{recording_id}/analyses", response_model=list[AnalysisDto])
def list_analyses(recording_id: str, app: ContainerDep) -> list[AnalysisDto]:
    return [_analysis(item) for item in app.recordings.list_analyses.execute(recording_id)]


def _source_recording_id(recording: Recording) -> str | None:
    studio_master = (recording.session_metadata or {}).get("studioMaster", {})
    source = studio_master.get("sourceRecordingId") if isinstance(studio_master, Mapping) else None
    return source if isinstance(source, str) else None


def _current_room_performance(
    app: ApplicationContainer, recording: Recording, sources: Mapping[str, Recording] | None
) -> RoomPerformanceDto | None:
    performance = _room_performance(recording)
    source_id = _source_recording_id(recording)
    if source_id and performance:
        try:
            source = (
                app.recordings.get.execute(source_id) if sources is None else sources.get(source_id)
            )
            if source is not None:
                return _room_performance(source) or performance
        except NotFoundError:
            pass  # A preserved master remains readable after deleting its original take.
    return performance


def _recording(
    app: ApplicationContainer,
    recording: Recording,
    *,
    analysis_status: str | None = None,
    sources: Mapping[str, Recording] | None = None,
) -> RecordingDto:
    if analysis_status is None:
        analysis_status = app.recordings.list_analyses.statuses([recording])[recording.recording_id]
    source_recording_id = _source_recording_id(recording)
    file_status = recording.file_status
    try:
        size_bytes = recording.file_path.stat().st_size
    except (FileNotFoundError, NotADirectoryError):
        size_bytes = 0
        if file_status in {"Ready", "RecoveredIncomplete"}:
            file_status = "Missing"
    except OSError:
        size_bytes = 0
    return RecordingDto(
        recording_id=recording.recording_id,
        file_path=str(recording.file_path),
        duration=recording.duration,
        sample_rate=recording.sample_rate,
        channels=recording.channels,
        created_at=recording.created_at,
        song_id=recording.song_id,
        song_revision=recording.song_revision,
        display_name=recording.display_name,
        file_status=file_status,
        analysis_status=analysis_status,
        source_recording_id=source_recording_id,
        size_bytes=size_bytes,
        room_performance=_current_room_performance(app, recording, sources),
        room_sources=room_source_state(recording),
    )


def _room_performance(recording: Recording) -> RoomPerformanceDto | None:
    raw = (recording.session_metadata or {}).get("roomPerformance")
    if raw is None:
        return None
    try:
        return RoomPerformanceDto.model_validate(raw)
    except ValidationError:
        return None


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
        rhythm_accuracy_percent=result.rhythm_accuracy_percent,
        note_stability_percent=result.note_stability_percent,
        problem_regions=[dict(item) for item in result.problem_regions],
        error=result.error,
    )
