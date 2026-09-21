from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.models.domain import ComputeMode
from backend.settings.domain import BackendSettings

router = APIRouter(prefix="/settings")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class SettingsDto(ApiModel):
    settings_schema_version: int
    compute_mode: ComputeMode
    cpu_threads: int
    selected_separation_provider: str | None
    selected_asr_provider: str | None
    selected_pitch_provider: str | None
    selected_alignment_provider: str | None


class UpdateSettingsDto(ApiModel):
    compute_mode: ComputeMode | None = None
    cpu_threads: int | None = Field(default=None, ge=1, le=256)
    selected_separation_provider: str | None = Field(default=None, max_length=128)
    selected_asr_provider: str | None = Field(default=None, max_length=128)
    selected_pitch_provider: str | None = Field(default=None, max_length=128)
    selected_alignment_provider: str | None = Field(default=None, max_length=128)


@router.get("", response_model=SettingsDto)
def get_settings(app: ContainerDep) -> SettingsDto:
    return _settings(app.system.settings.execute())


@router.patch("", response_model=SettingsDto)
def update_settings(body: UpdateSettingsDto, app: ContainerDep) -> SettingsDto:
    value = app.system.update_settings.execute(
        compute_mode=body.compute_mode,
        cpu_threads=body.cpu_threads,
        separation_provider=body.selected_separation_provider,
        asr_provider=body.selected_asr_provider,
        pitch_provider=body.selected_pitch_provider,
        alignment_provider=body.selected_alignment_provider,
    )
    return _settings(value)


def _settings(value: BackendSettings) -> SettingsDto:
    return SettingsDto(
        settings_schema_version=value.settings_schema_version,
        compute_mode=value.compute_mode,
        cpu_threads=value.cpu_threads,
        selected_separation_provider=value.selected_separation_provider,
        selected_asr_provider=value.selected_asr_provider,
        selected_pitch_provider=value.selected_pitch_provider,
        selected_alignment_provider=value.selected_alignment_provider,
    )
