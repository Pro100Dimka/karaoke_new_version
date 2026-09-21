from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.idempotency import IdempotencyRecord
from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import IdempotencyRow


class SqlIdempotencyRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, operation: str, key: str) -> IdempotencyRecord | None:
        row = self._session.scalar(
            select(IdempotencyRow).where(
                IdempotencyRow.operation == operation,
                IdempotencyRow.key == key,
            )
        )
        if row is None:
            return None
        return IdempotencyRecord(
            operation=row.operation,
            key=row.key,
            request_hash=row.request_hash,
            response_json=row.response_json,
            created_at=as_utc(row.created_at),
        )

    def add(self, record: IdempotencyRecord) -> None:
        self._session.add(
            IdempotencyRow(
                operation=record.operation,
                key=record.key,
                request_hash=record.request_hash,
                response_json=record.response_json,
                created_at=record.created_at,
            )
        )
