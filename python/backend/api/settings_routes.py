from __future__ import annotations

import secrets
import time
from concurrent.futures import Future, ThreadPoolExecutor
from threading import Lock
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
from backend.infrastructure.kaggle_notebook_automation import (
    KaggleNotebookAutomation,
    installation_notebook_slug,
)
from backend.domain_errors import DependencyError, DomainError

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


_kaggle_deployment_lock = Lock()
_kaggle_deployment_executor = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="kaggle-deployment",
)
_active_kaggle_deployment: Future[KaggleActionDto] | None = None


def _clear_kaggle_deployment(completed: Future[KaggleActionDto]) -> None:
    global _active_kaggle_deployment
    with _kaggle_deployment_lock:
        if _active_kaggle_deployment is completed:
            _active_kaggle_deployment = None


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


def _kaggle_account_token(app: ApplicationContainer) -> str:
    store = default_environment_store()
    account_token = next(
        entry.value.strip() for entry in store.read() if entry.key == "KAGGLE_API_TOKEN"
    )
    if account_token:
        return account_token
    legacy_token = (app.system.settings.execute().kaggle_token or "").strip()
    if legacy_token:
        store.save("KAGGLE_API_TOKEN", legacy_token)
    return legacy_token


def _kaggle_notebook_slug(app: ApplicationContainer) -> str:
    return installation_notebook_slug(app.roots.app)


def _wait_for_kaggle_notebook(settings: BackendSettings) -> None:
    deadline = time.monotonic() + 15 * 60
    provider = KaggleAiProvider(lambda: settings)
    while True:
        try:
            provider.validate_configuration()
            return
        except DomainError as error:
            if time.monotonic() >= deadline:
                raise DependencyError(
                    "KaggleNotebookStartupTimeout",
                    "Kaggle notebook did not become ready in time",
                ) from error
            time.sleep(5)


@router.get("/environment", response_model=list[EnvironmentEntryDto])
def get_environment_settings(app: ContainerDep) -> list[EnvironmentEntryDto]:
    _kaggle_account_token(app)
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
def login_to_kaggle(app: ContainerDep) -> KaggleActionDto:
    return KaggleActionDto(
        state="valid",
        message=KaggleNotebookAutomation(account_token=_kaggle_account_token(app)).login(),
    )


@router.post("/kaggle/deploy", response_model=KaggleActionDto)
def deploy_kaggle_notebook(app: ContainerDep) -> KaggleActionDto:
    global _active_kaggle_deployment
    with _kaggle_deployment_lock:
        active = _active_kaggle_deployment
        if active is None:
            active = _kaggle_deployment_executor.submit(_deploy_kaggle_notebook, app)
            _active_kaggle_deployment = active
            created = True
        else:
            created = False
    if created:
        active.add_done_callback(_clear_kaggle_deployment)
    return active.result()


def _deploy_kaggle_notebook(app: ApplicationContainer) -> KaggleActionDto:
    current = app.system.settings.execute()
    token = (
        current.kaggle_token
        if current.kaggle_url and current.kaggle_token
        else secrets.token_urlsafe(32)
    )
    environment = {entry.key: entry.value for entry in default_environment_store().read()}
    host = environment["AD_VOICE_ROOM_SERVER_HOST"].strip()
    port = environment["AD_VOICE_ROOM_SERVER_PORT"].strip()
    deployment = KaggleNotebookAutomation(account_token=_kaggle_account_token(app)).deploy(
        token,
        f"http://{host}:{port}",
        _kaggle_notebook_slug(app),
    )
    settings = app.system.update_settings.execute(
        kaggle_url=deployment.url,
        kaggle_token=token,
    )
    _wait_for_kaggle_notebook(settings)
    return KaggleActionDto(
        state="valid",
        message=deployment.message,
        url=deployment.url,
    )


@router.patch("", response_model=SettingsDto)
def update_settings(body: UpdateSettingsDto, app: ContainerDep) -> SettingsDto:
    current = app.system.settings.execute()
    if (
        body.processing_backend is ProcessingBackend.LOCAL
        and current.processing_backend is ProcessingBackend.KAGGLE
    ):
        KaggleAiProvider(lambda: current).shutdown()
    kaggle_token = body.kaggle_token
    if body.processing_backend is ProcessingBackend.KAGGLE and not (
        kaggle_token or current.kaggle_token
    ):
        if not _kaggle_account_token(app):
            raise DomainError(
                "KaggleAuthenticationRequired",
                "Enter the Kaggle API token in ENV settings first",
                422,
            )
        kaggle_token = secrets.token_urlsafe(32)
    value = app.system.update_settings.execute(
        compute_mode=body.compute_mode,
        cpu_threads=body.cpu_threads,
        separation_provider=body.selected_separation_provider,
        asr_provider=body.selected_asr_provider,
        pitch_provider=body.selected_pitch_provider,
        alignment_provider=body.selected_alignment_provider,
        processing_backend=body.processing_backend,
        kaggle_url=body.kaggle_url,
        kaggle_token=kaggle_token,
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
