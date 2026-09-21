from __future__ import annotations

from typing import Protocol

from backend.settings.domain import BackendSettings


class SettingsRepository(Protocol):
    def get(self) -> BackendSettings: ...

    def save(self, settings: BackendSettings) -> None: ...
