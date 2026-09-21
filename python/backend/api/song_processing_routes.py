from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header

from backend.api.base_dto import JobRefDto
from backend.api.dependencies import container
from backend.api.song_dto import StartProcessingDto, job_dto
from backend.bootstrap.container import ApplicationContainer

router = APIRouter(prefix="/songs")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


@router.post("/{song_id}/processing", response_model=JobRefDto, status_code=202)
def start_processing(
    song_id: str,
    body: StartProcessingDto,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    correlation_id: Annotated[str | None, Header(alias="X-Correlation-ID")] = None,
) -> JobRefDto:
    job = app.songs.start_processing.execute(
        song_id,
        body.mode,
        online_lyrics=body.online_lyrics,
        idempotency_key=idempotency_key,
        correlation_id=correlation_id,
    )
    return job_dto(job)


@router.post("/{song_id}/processing/melody", response_model=JobRefDto, status_code=202)
def reprocess_melody(
    song_id: str,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    correlation_id: Annotated[str | None, Header(alias="X-Correlation-ID")] = None,
) -> JobRefDto:
    job = app.songs.reprocess_melody.execute(
        song_id,
        idempotency_key=idempotency_key,
        correlation_id=correlation_id,
    )
    return job_dto(job)


@router.post("/processing/{job_id}/cancel", response_model=JobRefDto)
def cancel_processing(job_id: str, app: ContainerDep) -> JobRefDto:
    return job_dto(app.songs.cancel_processing.execute(job_id))
