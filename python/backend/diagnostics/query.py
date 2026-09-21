from __future__ import annotations

from dataclasses import asdict
from typing import Mapping

from backend.bootstrap.lifecycle import BackendLifecycle
from backend.domain_errors import DomainError
from backend.diagnostics.ports import RuntimeProbe
from backend.persistence import UnitOfWorkFactory
from backend.processing.ports import JobExecutor
from backend.recovery.ports import RecoveryJournal
from backend.storage.ports import StorageSystem
from backend.version import (
    API_VERSION,
    BACKEND_VERSION,
    DB_SCHEMA_VERSION,
    PACKAGE_FORMAT_VERSION,
    PROJECT_FORMAT_VERSION,
    SETTINGS_SCHEMA_VERSION,
)


class GetDiagnostics:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        lifecycle: BackendLifecycle,
        runtime: RuntimeProbe,
        storage: StorageSystem,
        executor: JobExecutor,
        recovery: RecoveryJournal,
    ) -> None:
        self._uow = uow
        self._lifecycle = lifecycle
        self._runtime = runtime
        self._storage = storage
        self._executor = executor
        self._recovery = recovery

    def execute(self) -> Mapping[str, object]:
        lifecycle = self._lifecycle.snapshot()
        runtime = self._runtime.inspect()
        return {
            "backend": {
                "state": lifecycle.state.value,
                "reasons": lifecycle.reasons,
                "database": self._database_ok(),
                "scheduler": self._executor.stats(),
            },
            "ai": asdict(runtime),
            "storage": {"usage": dict(self._storage.usage())},
            "recovery": {"interruptedTransactions": len(self._recovery.entries())},
            "versions": {
                "backendVersion": BACKEND_VERSION,
                "apiVersion": API_VERSION,
                "dbSchema": DB_SCHEMA_VERSION,
                "settingsSchema": SETTINGS_SCHEMA_VERSION,
                "projectFormat": PROJECT_FORMAT_VERSION,
                "packageFormat": PACKAGE_FORMAT_VERSION,
            },
        }

    def _database_ok(self) -> bool:
        try:
            with self._uow.create() as transaction:
                transaction.settings.get()
            return True
        except DomainError:
            return False
