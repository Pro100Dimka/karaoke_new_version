from __future__ import annotations

from backend.persistence import UnitOfWorkFactory
from backend.settings.domain import BackendSettings


class GetSettings:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self) -> BackendSettings:
        with self._uow.create() as transaction:
            return transaction.settings.get()
