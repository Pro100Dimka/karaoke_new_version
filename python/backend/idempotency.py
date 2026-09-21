from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True, slots=True)
class IdempotencyRecord:
    operation: str
    key: str
    request_hash: str
    response_json: str
    created_at: datetime


class IdempotencyRepository(Protocol):
    def get(self, operation: str, key: str) -> IdempotencyRecord | None: ...

    def add(self, record: IdempotencyRecord) -> None: ...
