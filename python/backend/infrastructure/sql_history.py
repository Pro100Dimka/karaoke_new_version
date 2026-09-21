from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from backend.history.domain import HistoryEvent
from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import HistoryRow
from backend.serialization import dumps, loads_object


def _to_domain(row: HistoryRow) -> HistoryEvent:
    details = dict(loads_object(row.details_json)) if row.details_json else None
    return HistoryEvent(
        event_id=row.event_id,
        event_type=row.event_type,
        entity_type=row.entity_type,
        entity_id=row.entity_id,
        details=details,
        created_at=as_utc(row.created_at),
    )


class SqlHistoryRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def add(self, event: HistoryEvent) -> None:
        self._session.add(
            HistoryRow(
                event_id=event.event_id,
                event_type=event.event_type,
                entity_type=event.entity_type,
                entity_id=event.entity_id,
                details_json=dumps(event.details) if event.details else None,
                created_at=event.created_at,
            )
        )

    def list(self, *, limit: int, offset: int) -> Sequence[HistoryEvent]:
        query = select(HistoryRow).order_by(HistoryRow.created_at.desc(), HistoryRow.event_id)
        query = query.limit(limit).offset(offset)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def count(self) -> int:
        return int(self._session.scalar(select(func.count()).select_from(HistoryRow)) or 0)
