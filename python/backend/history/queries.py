from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from backend.history.domain import HistoryEvent
from backend.persistence import UnitOfWorkFactory


@dataclass(frozen=True, slots=True)
class HistoryPage:
    items: Sequence[HistoryEvent]
    total: int
    limit: int
    offset: int


class ListHistory:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, *, limit: int, offset: int) -> HistoryPage:
        with self._uow.create() as transaction:
            items = transaction.history.list(limit=limit, offset=offset)
            total = transaction.history.count()
        return HistoryPage(items, total, limit, offset)
