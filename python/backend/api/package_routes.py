from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from pydantic import Field

from backend.api.base_dto import ApiModel, JobRefDto
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.packages.domain import PackageImportDecision

router = APIRouter(prefix="/packages")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class PackagePathDto(ApiModel):
    path: str = Field(min_length=1, max_length=4096)


class PackageImportDto(PackagePathDto):
    decision: PackageImportDecision = PackageImportDecision.SAFE_ONLY


class PackageInspectionDto(ApiModel):
    compatibility: str
    conflict: str
    existing_song_id: str | None
    song_id: str
    revision: int


@router.post("/inspect", response_model=PackageInspectionDto)
def inspect_package(body: PackagePathDto, app: ContainerDep) -> PackageInspectionDto:
    result = app.packages.inspect.execute(Path(body.path))
    return PackageInspectionDto(
        compatibility=result.compatibility.value,
        conflict=result.conflict.value,
        existing_song_id=result.existing_song_id,
        song_id=result.manifest.song.song_id,
        revision=result.manifest.revision,
    )


@router.post("/export/{song_id}", response_model=JobRefDto, status_code=202)
def export_package(song_id: str, app: ContainerDep, revision: int | None = None) -> JobRefDto:
    job = app.packages.start_export.execute(song_id, revision)
    return JobRefDto(job_id=job.job_id, state=job.state.value)


@router.post("/import", response_model=JobRefDto, status_code=202)
def import_package(
    body: PackageImportDto,
    app: ContainerDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> JobRefDto:
    job = app.packages.start_import.execute(Path(body.path), body.decision, idempotency_key)
    return JobRefDto(job_id=job.job_id, state=job.state.value)
