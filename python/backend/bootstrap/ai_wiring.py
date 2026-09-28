from __future__ import annotations

import importlib.util
import os
import shlex
import sys
from collections.abc import Callable, Sequence

from backend.ai.catalog import CATALOG
from backend.ai.domain import AiCapability, AiProviderDescriptor, RequiredModel
from backend.ai.ports import AiProvider
from backend.bootstrap.config import BackendConfig
from backend.domain_errors import DependencyError
from backend.infrastructure.command_ai_provider import CommandAiProvider
from backend.infrastructure.kaggle_ai_provider import KaggleAiProvider
from backend.infrastructure.kaggle_notebook_automation import (
    KaggleNotebookAutomation,
    installation_notebook_slug,
)
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.ports import OnlineLyricsProvider
from backend.models.commands import DeclareModel
from backend.lyrics.retry import CancelAwareWaiter, RetryingLyricsProvider, RetryPolicy
from backend.settings.domain import BackendSettings
from backend.settings.environment import default_environment_store


def configured_ai_providers(
    config: BackendConfig,
    processes: ProcessRunner,
    settings: Callable[[], BackendSettings],
) -> tuple[AiProvider, ...]:
    raw = os.getenv("AD_VOICE_AI_COMMAND", "").strip()
    if raw:
        local: tuple[AiProvider, ...] = (
            _command_provider(
                "external-local",
                os.getenv("AD_VOICE_AI_VERSION", "1"),
                shlex.split(raw, posix=os.name != "nt"),
                (),
                config,
                processes,
            ),
        )
    elif not _worker_libraries_installed():
        local = ()
    else:
        required = tuple(spec.required for spec in CATALOG)
        worker = [sys.executable, "-m", "backend.ai_worker"]
        local = (_command_provider("local-torch", "1", worker, required, config, processes),)
    return (
        *local,
        KaggleAiProvider(
            settings,
            start_notebook=lambda: _start_kaggle_notebook(config, settings),
        ),
    )


def _start_kaggle_notebook(
    config: BackendConfig,
    settings: Callable[[], BackendSettings],
) -> None:
    current = settings()
    if not current.kaggle_token:
        raise DependencyError(
            "KaggleNotConfigured", "Kaggle notebook token is not configured"
        )
    environment = {entry.key: entry.value for entry in default_environment_store().read()}
    account_token = environment["KAGGLE_API_TOKEN"].strip()
    if not account_token:
        raise DependencyError(
            "KaggleAuthenticationRequired", "Kaggle account token is not configured"
        )
    host = environment["AD_VOICE_ROOM_SERVER_HOST"].strip()
    port = environment["AD_VOICE_ROOM_SERVER_PORT"].strip()
    KaggleNotebookAutomation(account_token=account_token).deploy(
        current.kaggle_token,
        f"http://{host}:{port}",
        installation_notebook_slug(config.roots.app),
    )


def _worker_libraries_installed() -> bool:
    return all(
        importlib.util.find_spec(name) is not None
        for name in (
            "torch",
            "torchaudio",
            "demucs",
            "whisper",
            "faster_whisper",
            "torchcrepe",
            "uroman",
        )
    )


def _command_provider(
    provider_id: str,
    version: str,
    command: list[str],
    required_models: tuple[RequiredModel, ...],
    config: BackendConfig,
    processes: ProcessRunner,
) -> AiProvider:
    descriptor = AiProviderDescriptor(
        provider_id=provider_id,
        version=version,
        capabilities=frozenset(AiCapability),
        supported_languages=frozenset({"Auto", "Ukrainian", "Russian", "English"}),
        required_models=required_models,
        required_resources={
            "cpuThreads": config.resources.cpu_threads,
            "supportsCuda": provider_id == "local-torch",
        },
    )
    return CommandAiProvider(
        descriptor,
        command,
        processes,
    )


def retrying_lyrics_providers(
    providers: Sequence[OnlineLyricsProvider],
) -> tuple[OnlineLyricsProvider, ...]:
    waiter = CancelAwareWaiter()
    policy = RetryPolicy()
    return tuple(RetryingLyricsProvider(provider, policy, waiter) for provider in providers)


def declare_model_catalog(declare: DeclareModel) -> None:
    """Registers the models of the built-in provider so they appear in Settings and can be downloaded."""
    for spec in CATALOG:
        declare.execute(
            spec.model_id,
            spec.purpose,
            spec.version,
            spec.size,
            spec.checksum,
            spec.download_url,
            False,
        )
