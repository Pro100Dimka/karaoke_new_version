from __future__ import annotations

from functools import partial

from backend.bootstrap.container import SystemCases
from backend.bootstrap.lifecycle import BackendLifecycle
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.capabilities.domain import Capabilities
from backend.capabilities.query import GetCapabilities
from backend.diagnostics.query import GetDiagnostics
from backend.history.queries import ListHistory
from backend.infrastructure.database import Database
from backend.infrastructure.job_executor import BoundedJobExecutor
from backend.recovery.background import StartLibraryReconciliation
from backend.recovery.reconcile_library import ReconcileLibrary
from backend.settings.queries import get_settings, SettingsReader
from backend.settings.update_settings import UpdateSettings, ValidateSettingsSchema


def build_system_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    lifecycle: BackendLifecycle,
    executor: BoundedJobExecutor,
    settings: SettingsReader,
    reconcile: ReconcileLibrary,
) -> SystemCases:
    current = processing.runtime_now or processing.runtime
    capabilities = GetCapabilities(
        runtime.database,
        processing.registry,
        current,
        online_lyrics_available=bool(processing.lyrics_providers),
    )
    diagnostics = GetDiagnostics(
        runtime.database,
        lifecycle,
        current,
        processing.storage,
        executor,
        project.journal,
    )
    return SystemCases(
        capabilities,
        diagnostics,
        settings,
        UpdateSettings(runtime.database, project.operations),
        ListHistory(runtime.database),
        processing.jobs,
        StartLibraryReconciliation(processing.jobs, reconcile),
        processing.storage.clear_cache,
        partial(processing.storage.cleanup_temp, 3600),
        lambda area: processing.storage.free_bytes(
            {"data": runtime.config.roots.app, "models": runtime.config.roots.models}[area]
        ),
    )


def validated_settings(database: Database) -> SettingsReader:
    settings = partial(get_settings, database)
    current = settings()
    validated = ValidateSettingsSchema().execute(current)
    if validated != current:
        with database.create() as transaction:
            transaction.settings.save(validated)
            transaction.commit()
    return settings


def set_ready_state(lifecycle: BackendLifecycle, capabilities: Capabilities) -> None:
    reasons: list[str] = []
    if not capabilities.can_import_songs:
        reasons.append("FFmpeg unavailable")
    if not capabilities.can_process_songs:
        reasons.append("AI processing unavailable")
    if reasons:
        lifecycle.degraded(*reasons)
        return
    lifecycle.ready()
