from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Sequence

from backend.domain_errors import DependencyError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.runtime import Clock
from backend.runtime import IdGenerator
from backend.serialization import dumps, loads_object
from backend.recovery.domain import RecoveryEntry, RecoveryOperation


class FileRecoveryJournal:
    def __init__(self, root: Path, clock: Clock, ids: IdGenerator) -> None:
        self._root = root
        self._clock = clock
        self._ids = ids

    def begin(self, operation: RecoveryOperation, data: dict[str, object]) -> RecoveryEntry:
        entry = RecoveryEntry(self._ids.new(), operation, self._clock.now(), data)
        payload = {
            "transactionId": entry.transaction_id,
            "operation": entry.operation,
            "createdAt": entry.created_at,
            "data": entry.data,
        }
        atomic_write_text(self._path(entry.transaction_id), dumps(payload))
        return entry

    def complete(self, transaction_id: str) -> None:
        try:
            self._path(transaction_id).unlink(missing_ok=True)
        except OSError as exc:
            raise DependencyError(
                "RecoveryJournalUnavailable", "Could not complete recovery entry"
            ) from exc

    def entries(self) -> Sequence[RecoveryEntry]:
        if not self._root.exists():
            return ()
        entries: list[RecoveryEntry] = []
        for path in sorted(self._root.glob("*.json")):
            entries.append(self._read(path))
        return tuple(entries)

    def _read(self, path: Path) -> RecoveryEntry:
        try:
            data = loads_object(path.read_text(encoding="utf-8"))
            created_at = datetime.fromisoformat(str(data["createdAt"]))
            raw_data = data.get("data")
            if not isinstance(raw_data, dict):
                raise ValueError("Recovery data must be an object")
            return RecoveryEntry(
                transaction_id=str(data["transactionId"]),
                operation=RecoveryOperation(str(data["operation"])),
                created_at=created_at,
                data=dict(raw_data),
            )
        except (OSError, KeyError, ValueError) as exc:
            raise DependencyError(
                "RecoveryJournalCorrupt", "Recovery entry is invalid", path=str(path)
            ) from exc

    def _path(self, transaction_id: str) -> Path:
        self._root.mkdir(parents=True, exist_ok=True)
        return self._root / f"{transaction_id}.json"
