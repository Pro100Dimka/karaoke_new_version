from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import Field

from backend.ai.domain import AiCapability
from backend.api.base_dto import ApiModel, JobRefDto
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.models.domain import AiModel

router = APIRouter(prefix="/models")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class DeclareModelDto(ApiModel):
    model_id: str = Field(min_length=1, max_length=128)
    purpose: AiCapability
    version: str = Field(min_length=1, max_length=128)
    size: int = Field(ge=0)
    checksum: str = Field(min_length=64, max_length=64)
    download_url: str | None = Field(default=None, max_length=2000)
    selected: bool = False


class ModelDto(ApiModel):
    model_id: str
    purpose: AiCapability
    version: str
    size: int
    checksum: str
    state: str
    selected: bool
    updated_at: datetime
    local_path: str | None


@router.get("", response_model=list[ModelDto])
def list_models(app: ContainerDep, purpose: AiCapability | None = None) -> list[ModelDto]:
    return [_model(item) for item in app.models.list.execute(purpose)]


@router.put("/{model_id}/{version}", response_model=ModelDto)
def declare_model(
    model_id: str,
    version: str,
    body: DeclareModelDto,
    app: ContainerDep,
) -> ModelDto:
    model = app.models.declare.execute(
        model_id,
        body.purpose,
        version,
        body.size,
        body.checksum,
        body.download_url,
        body.selected,
    )
    return _model(model)


@router.post("/{model_id}/{version}/select", response_model=ModelDto)
def select_model(model_id: str, version: str, app: ContainerDep) -> ModelDto:
    return _model(app.models.select.execute(model_id, version))


@router.post("/{model_id}/{version}/download", response_model=JobRefDto, status_code=202)
def download_model(model_id: str, version: str, app: ContainerDep) -> JobRefDto:
    job = app.models.download.execute(model_id, version)
    return JobRefDto(job_id=job.job_id, state=job.state.value)


def _model(model: AiModel) -> ModelDto:
    return ModelDto(
        model_id=model.model_id,
        purpose=model.purpose,
        version=model.version,
        size=model.size,
        checksum=model.checksum,
        state=model.state.value,
        selected=model.selected,
        updated_at=model.updated_at,
        local_path=str(model.local_path) if model.local_path else None,
    )
