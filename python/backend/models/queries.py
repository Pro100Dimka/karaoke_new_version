from __future__ import annotations

from typing import Sequence

from backend.ai.domain import AiCapability
from backend.models.domain import AiModel
from backend.persistence import UnitOfWorkFactory


class ListModels:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, purpose: AiCapability | None = None) -> Sequence[AiModel]:
        with self._uow.create() as transaction:
            return transaction.models.list(purpose)
