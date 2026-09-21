from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import ConflictError, DomainError
from backend.models.domain import ComputeMode
from backend.persistence import UnitOfWorkFactory
from backend.projects.operations import SongOperationRegistry
from backend.settings.domain import BackendSettings
from backend.version import SETTINGS_SCHEMA_VERSION


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
    ) -> BackendSettings:
        if self._operations.any_active():
            raise ConflictError(
                "SettingsConflict", "Settings cannot change during project-mutating operations"
            )
        with self._uow.create() as transaction:
            current = transaction.settings.get()
            updated = replace(
                current,
                settings_schema_version=SETTINGS_SCHEMA_VERSION,
                compute_mode=compute_mode or current.compute_mode,
                cpu_threads=cpu_threads or current.cpu_threads,
                selected_separation_provider=separation_provider
                or current.selected_separation_provider,
                selected_asr_provider=asr_provider or current.selected_asr_provider,
                selected_pitch_provider=pitch_provider or current.selected_pitch_provider,
                selected_alignment_provider=alignment_provider
                or current.selected_alignment_provider,
            )
            transaction.settings.save(updated)
            transaction.commit()
        return updated


class ValidateSettingsSchema:
    def execute(self, settings: BackendSettings) -> BackendSettings:
        if settings.settings_schema_version > SETTINGS_SCHEMA_VERSION:
            raise DomainError(
                "SettingsVersionUnsupported", "Settings schema is newer than this backend", 409
            )
        if settings.settings_schema_version < 1:
            return replace(settings, settings_schema_version=SETTINGS_SCHEMA_VERSION)
        return settings
