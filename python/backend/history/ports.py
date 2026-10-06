from __future__ import annotations

from typing import Collection, Protocol, Sequence

from backend.history.domain import HistoryEvent


class HistoryRepository(Protocol):
    def add(self, event: HistoryEvent) -> None: ...

    def list(
        self, *, limit: int, offset: int, event_types: Collection[str] | None = None
    ) -> Sequence[HistoryEvent]: ...

    def count(self, event_types: Collection[str] | None = None) -> int: ...
