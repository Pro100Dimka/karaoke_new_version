from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import ConflictError, DomainError
from backend.models.domain import ComputeMode
from backend.persistence import UnitOfWorkFactory
from backend.projects.operations import SongOperationRegistry
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.version import SETTINGS_SCHEMA_VERSION


def _updated_text(current: str | None, value: str | None) -> str | None:
    return current if value is None else value or None


class UpdateSettings:
    def __init__(self, uow: UnitOfWorkFactory, operations: SongOperationRegistry) -> None:
        self._uow = uow
        self._operations = operations

    def execute(
        self,
        *,
        compute_mode: ComputeMode | None = None,
        cpu_threads: int | None = None,
        separation_provider: str | None = None,
        asr_provider: str | None = None,
        pitch_provider: str | None = None,
        alignment_provider: str | None = None,
        processing_backend: ProcessingBackend | None = None,
        kaggle_url: str | None = None,
        kaggle_token: str | None = None,
    ) -> BackendSettings:
        if self._operations.any_active():
            raise ConflictError("SettingsConflict", "Settings cannot change during operations")
        with self._uow.create() as transaction:
            current = transaction.settings.get()
            updated = replace(
                current,
                settings_schema_version=SETTINGS_SCHEMA_VERSION,
                compute_mode=compute_mode or current.compute_mode,
                cpu_threads=cpu_threads or current.cpu_threads,
                selected_separation_provider=_updated_text(
                    current.selected_separation_provider, separation_provider
                ),
                selected_asr_provider=_updated_text(current.selected_asr_provider, asr_provider),
                selected_pitch_provider=_updated_text(
                    current.selected_pitch_provider, pitch_provider
                ),
                selected_alignment_provider=_updated_text(
                    current.selected_alignment_provider, alignment_provider
                ),
                processing_backend=processing_backend or current.processing_backend,
                kaggle_url=_updated_text(current.kaggle_url, kaggle_url),
                kaggle_token=kaggle_token or current.kaggle_token,
            )
            _validate_kaggle(updated.processing_backend, updated.kaggle_url, updated.kaggle_token)
            transaction.settings.save(updated)
            transaction.commit()
        return updated


def _validate_kaggle(backend: ProcessingBackend, url: str | None, token: str | None) -> None:
    if backend is not ProcessingBackend.KAGGLE:
        return
    if not token:
        raise DomainError("KaggleNotConfigured", "Kaggle access token is required", 422)
    if url and not (url.startswith("https://") or url.startswith("http://127.0.0.1")):
        raise DomainError("KaggleUrlInvalid", "Kaggle URL must use HTTPS", 422)


class ValidateSettingsSchema:
    def execute(self, settings: BackendSettings) -> BackendSettings:
        if settings.settings_schema_version > SETTINGS_SCHEMA_VERSION:
            raise DomainError(
                "SettingsVersionUnsupported", "Settings schema is newer than this backend", 409
            )
        if settings.settings_schema_version < SETTINGS_SCHEMA_VERSION:
            return replace(settings, settings_schema_version=SETTINGS_SCHEMA_VERSION)
        return settings
