from __future__ import annotations

from collections.abc import Callable

from backend.persistence import UnitOfWorkFactory
from backend.settings.domain import BackendSettings


SettingsReader = Callable[[], BackendSettings]


def get_settings(uow: UnitOfWorkFactory) -> BackendSettings:
    with uow.create() as transaction:
        return transaction.settings.get()
