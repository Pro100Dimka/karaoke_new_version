from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.models.domain import ComputeMode
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.settings.environment import EnvironmentEntry, default_environment_store
from backend.infrastructure.kaggle_ai_provider import KaggleAiProvider
from backend.infrastructure.kaggle_notebook_automation import KaggleNotebookAutomation
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
    kaggle_token: str | None
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
    return EnvironmentEntryDto(
        key=value.key,
        group=value.group,
        kind=value.kind,
        value=value.value,
        configured=value.configured,
        state=value.state,
        message=value.message,
    )


@router.get("", response_model=SettingsDto)
def get_settings(app: ContainerDep) -> SettingsDto:
    return _settings(app.system.settings.execute())


@router.get("/environment", response_model=list[EnvironmentEntryDto])
def get_environment_settings() -> list[EnvironmentEntryDto]:
    return [_environment_entry(value) for value in default_environment_store().read()]


@router.patch("/environment/{key}", response_model=EnvironmentEntryDto)
def update_environment_setting(key: str, body: UpdateEnvironmentEntryDto) -> EnvironmentEntryDto:
    return _environment_entry(default_environment_store().save(key, body.value))


@router.post("/environment/{key}/verify", response_model=EnvironmentEntryDto)
def verify_environment_setting(key: str) -> EnvironmentEntryDto:
    return _environment_entry(default_environment_store().verify(key))


@router.post("/kaggle/verify", response_model=ConfigurationValidationDto)
def verify_kaggle_settings(app: ContainerDep) -> ConfigurationValidationDto:
    settings = app.system.settings.execute()
    try:
        KaggleAiProvider(lambda: settings).validate_configuration()
    except DomainError as error:
        return ConfigurationValidationDto(state="invalid", message=error.message)
    return ConfigurationValidationDto(state="valid", message="Kaggle notebook is available")


@router.post("/kaggle/login", response_model=KaggleActionDto)
def login_to_kaggle() -> KaggleActionDto:
    return KaggleActionDto(
        state="valid",
        message=KaggleNotebookAutomation().login(),
    )


@router.post("/kaggle/deploy", response_model=KaggleActionDto)
def deploy_kaggle_notebook(app: ContainerDep) -> KaggleActionDto:
    settings = app.system.settings.execute()
    token = settings.kaggle_token or secrets.token_urlsafe(32)
    if not settings.kaggle_token:
        settings = app.system.update_settings.execute(kaggle_token=token)
    environment = {entry.key: entry.value for entry in default_environment_store().read()}
    host = environment["AD_VOICE_ROOM_SERVER_HOST"].strip()
    port = environment["AD_VOICE_ROOM_SERVER_PORT"].strip()
    deployment = KaggleNotebookAutomation().deploy(
        token,
        f"http://{host}:{port}",
    )
    return KaggleActionDto(
        state="valid",
        message=deployment.message,
        url=deployment.url,
    )


@router.patch("", response_model=SettingsDto)
def update_settings(body: UpdateSettingsDto, app: ContainerDep) -> SettingsDto:
    value = app.system.update_settings.execute(
        compute_mode=body.compute_mode,
        cpu_threads=body.cpu_threads,
        separation_provider=body.selected_separation_provider,
        asr_provider=body.selected_asr_provider,
        pitch_provider=body.selected_pitch_provider,
        alignment_provider=body.selected_alignment_provider,
        processing_backend=body.processing_backend,
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
        kaggle_token=value.kaggle_token,
        kaggle_configured=bool(value.kaggle_token),
    )
