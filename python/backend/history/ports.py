from __future__ import annotations

from typing import Protocol, Sequence

from backend.history.domain import HistoryEvent


class HistoryRepository(Protocol):
    def add(self, event: HistoryEvent) -> None: ...

    def list(self, *, limit: int, offset: int) -> Sequence[HistoryEvent]: ...

    def count(self) -> int: ...
