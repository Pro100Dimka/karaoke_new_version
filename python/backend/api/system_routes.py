from __future__ import annotations

import queue
from datetime import datetime
from collections.abc import Iterator
from typing import Annotated, Mapping

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from backend.api.base_dto import ApiModel
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.capabilities.domain import Capabilities
from backend.history.domain import HistoryEvent
from backend.history.queries import HistoryPage
from backend.bootstrap.lifecycle import BackendState
from backend.processing.domain import Job, JobType
from backend.serialization import dumps
from backend.version import API_VERSION, BACKEND_VERSION

router = APIRouter()
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class HealthDto(ApiModel):
    ok: bool
    state: str
    instance_id: str


class VersionDto(ApiModel):
    backend_version: str
    api_version: int


class CapabilitiesDto(ApiModel):
    can_import_songs: bool
    can_process_songs: bool
    can_separate: bool
    can_run_asr: bool
    can_run_alignment: bool
    can_analyze_pitch: bool
    can_analyze_recording: bool
    can_use_cuda: bool
    online_lyrics_available: bool
    package_import_available: bool
    package_export_available: bool


class JobDto(ApiModel):
    job_id: str
    type: str
    state: str
    entity_id: str | None
    stage: str | None
    stage_progress: float
    overall_progress: float
    error: Mapping[str, object] | None
    report: Mapping[str, object] | None


class JobPageDto(ApiModel):
    items: list[JobDto]
    limit: int
    offset: int


class HistoryEventDto(ApiModel):
    event_id: str
    event_type: str
    created_at: datetime
    entity_type: str | None
    entity_id: str | None
    details: Mapping[str, object] | None


class HistoryPageDto(ApiModel):
    items: list[HistoryEventDto]
    total: int
    limit: int
    offset: int


@router.get("/health/live", response_model=HealthDto)
def live(app: ContainerDep) -> HealthDto:
    state = app.lifecycle.snapshot().state
    return HealthDto(ok=True, state=state.value, instance_id=app.lifecycle.instance_id)


@router.get("/health/ready", response_model=HealthDto)
def ready(app: ContainerDep) -> HealthDto:
    state = app.lifecycle.snapshot().state
    available = state in {BackendState.READY, BackendState.DEGRADED}
    return HealthDto(ok=available, state=state.value, instance_id=app.lifecycle.instance_id)


@router.get("/version", response_model=VersionDto)
def version() -> VersionDto:
    return VersionDto(backend_version=BACKEND_VERSION, api_version=API_VERSION)


@router.get("/capabilities", response_model=CapabilitiesDto)
def capabilities(app: ContainerDep) -> CapabilitiesDto:
    value = app.system.capabilities.execute()
    return _capabilities(value)


@router.get("/diagnostics")
def diagnostics(app: ContainerDep) -> Mapping[str, object]:
    return app.system.diagnostics.execute()


@router.get("/history", response_model=HistoryPageDto)
def history(
    app: ContainerDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> HistoryPageDto:
    return _history_page(app.system.history.execute(limit=limit, offset=offset))


@router.get("/jobs", response_model=JobPageDto)
def list_jobs(
    app: ContainerDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    job_type: JobType | None = Query(default=None, alias="type"),
) -> JobPageDto:
    jobs = app.system.jobs.list(limit=limit, offset=offset, job_type=job_type)
    return JobPageDto(items=[_job(item) for item in jobs], limit=limit, offset=offset)


@router.get("/jobs/{job_id}", response_model=JobDto)
def get_job(job_id: str, app: ContainerDep) -> JobDto:
    return _job(app.system.jobs.get(job_id))


@router.post("/jobs/{job_id}/cancel", response_model=JobDto)
def cancel_job(job_id: str, app: ContainerDep) -> JobDto:
    return _job(app.system.jobs.cancel(job_id))


class CleanupDto(ApiModel):
    removed: int


@router.post("/storage/cache/clear", response_model=CleanupDto)
def clear_cache(app: ContainerDep) -> CleanupDto:
    return CleanupDto(removed=app.system.clear_cache.execute().removed)


@router.post("/storage/temp/clear", response_model=CleanupDto)
def clear_temp(app: ContainerDep) -> CleanupDto:
    return CleanupDto(removed=app.system.remove_temp.execute().removed)


@router.post("/recovery/reconcile", response_model=JobDto, status_code=202)
def reconcile(app: ContainerDep) -> JobDto:
    return _job(app.system.reconcile.execute())


@router.get("/events")
def events(app: ContainerDep) -> StreamingResponse:
    return StreamingResponse(_events(app), media_type="text/event-stream")


def _events(app: ApplicationContainer) -> Iterator[str]:
    with app.events.subscribe() as subscriber:
        while True:
            try:
                event = subscriber.get(timeout=15)
            except queue.Empty:
                yield ": heartbeat\n\n"
                continue
            payload = {
                "type": event.event_type,
                "createdAt": event.created_at,
                "data": dict(event.data),
            }
            yield f"data: {dumps(payload)}\n\n"


def _history_event(event: HistoryEvent) -> HistoryEventDto:
    return HistoryEventDto(
        event_id=event.event_id,
        event_type=event.event_type,
        created_at=event.created_at,
        entity_type=event.entity_type,
        entity_id=event.entity_id,
        details=event.details,
    )


def _history_page(page: HistoryPage) -> HistoryPageDto:
    return HistoryPageDto(
        items=[_history_event(item) for item in page.items],
        total=page.total,
        limit=page.limit,
        offset=page.offset,
    )


def _job(job: Job) -> JobDto:
    return JobDto(
        job_id=job.job_id,
        type=job.job_type.value,
        state=job.state.value,
        entity_id=job.entity_id,
        stage=job.stage,
        stage_progress=job.stage_progress,
        overall_progress=job.overall_progress,
        error=job.error,
        report=job.report,
    )


def _capabilities(value: Capabilities) -> CapabilitiesDto:
    return CapabilitiesDto(
        can_import_songs=value.can_import_songs,
        can_process_songs=value.can_process_songs,
        can_separate=value.can_separate,
        can_run_asr=value.can_run_asr,
        can_run_alignment=value.can_run_alignment,
        can_analyze_pitch=value.can_analyze_pitch,
        can_analyze_recording=value.can_analyze_recording,
        can_use_cuda=value.can_use_cuda,
        online_lyrics_available=value.online_lyrics_available,
        package_import_available=value.package_import_available,
        package_export_available=value.package_export_available,
    )
