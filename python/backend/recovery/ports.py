from __future__ import annotations

from typing import Protocol, Sequence

from backend.recovery.domain import RecoveryEntry, RecoveryOperation


class RecoveryJournal(Protocol):
    def begin(self, operation: RecoveryOperation, data: dict[str, object]) -> RecoveryEntry: ...

    def complete(self, transaction_id: str) -> None: ...

    def entries(self) -> Sequence[RecoveryEntry]: ...
