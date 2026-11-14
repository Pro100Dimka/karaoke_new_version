from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.models.domain import ComputeMode
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.settings.environment import EnvironmentEntry, default_environment_store
from backend.infrastructure.oracle_ai_provider import OracleAiProvider
from backend.domain_errors import DomainError

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
    processing_backend: ProcessingBackend
    kaggle_url: str | None
    kaggle_configured: bool


class UpdateSettingsDto(ApiModel):
    compute_mode: ComputeMode | None = None
    cpu_threads: int | None = Field(default=None, ge=1, le=256)
    selected_separation_provider: str | None = Field(default=None, max_length=128)
    selected_asr_provider: str | None = Field(default=None, max_length=128)
    selected_pitch_provider: str | None = Field(default=None, max_length=128)
    selected_alignment_provider: str | None = Field(default=None, max_length=128)
    processing_backend: ProcessingBackend | None = None
    kaggle_url: str | None = Field(default=None, max_length=2048)
    kaggle_token: str | None = Field(default=None, min_length=8, max_length=256)


class EnvironmentEntryDto(ApiModel):
    key: str
    group: str
    kind: str
    value: str
    configured: bool
    state: str
    message: str


class UpdateEnvironmentEntryDto(ApiModel):
    value: str = Field(max_length=4096)


class ConfigurationValidationDto(ApiModel):
    state: str
    message: str


class KaggleActionDto(ApiModel):
    state: str
    message: str
    url: str | None = None


def _environment_entry(value: EnvironmentEntry) -> EnvironmentEntryDto:
    # Secrets are write-only over the API: the client learns only whether one is configured.
    return EnvironmentEntryDto(
        key=value.key,
        group=value.group,
        kind=value.kind,
        value="" if value.kind == "secret" else value.value,
        configured=value.configured,
        state=value.state,
        message=value.message,
    )


@router.get("", response_model=SettingsDto)
def get_settings(app: ContainerDep) -> SettingsDto:
    return _settings(app.system.settings())


@router.get("/environment", response_model=list[EnvironmentEntryDto])
def get_environment_settings(app: ContainerDep) -> list[EnvironmentEntryDto]:
    return [_environment_entry(value) for value in default_environment_store().read()]


@router.patch("/environment/{key}", response_model=EnvironmentEntryDto)
def update_environment_setting(key: str, body: UpdateEnvironmentEntryDto) -> EnvironmentEntryDto:
    return _environment_entry(default_environment_store().save(key, body.value))


@router.post("/environment/{key}/verify", response_model=EnvironmentEntryDto)
def verify_environment_setting(key: str) -> EnvironmentEntryDto:
    return _environment_entry(default_environment_store().verify(key))


@router.post("/processing/verify", response_model=ConfigurationValidationDto)
def verify_processing(app: ContainerDep) -> ConfigurationValidationDto:
    try:
        health = OracleAiProvider(app.roots.temp).validate_configuration()
    except DomainError as error:
        return ConfigurationValidationDto(state="invalid", message=error.message)
    return ConfigurationValidationDto(
        state="valid" if health["workerOnline"] else "unverified",
        message="Processing PC is online"
        if health["workerOnline"]
        else "Processing PC is offline; tasks remain queued",
    )


@router.patch("", response_model=SettingsDto)
def update_settings(body: UpdateSettingsDto, app: ContainerDep) -> SettingsDto:
    backend = body.processing_backend
    if backend is ProcessingBackend.KAGGLE:
        backend = ProcessingBackend.ORACLE
    value = app.system.update_settings.execute(
        compute_mode=body.compute_mode,
        cpu_threads=body.cpu_threads,
        separation_provider=body.selected_separation_provider,
        asr_provider=body.selected_asr_provider,
        pitch_provider=body.selected_pitch_provider,
        alignment_provider=body.selected_alignment_provider,
        processing_backend=backend,
        kaggle_url=body.kaggle_url,
        kaggle_token=body.kaggle_token,
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
        processing_backend=value.processing_backend,
        kaggle_url=value.kaggle_url,
        kaggle_configured=bool(value.kaggle_token),
    )
