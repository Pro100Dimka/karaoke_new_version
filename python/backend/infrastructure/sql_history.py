from __future__ import annotations

from collections.abc import Collection, Sequence

from sqlalchemy import func, select, union_all
from sqlalchemy.orm import Session, aliased

from backend.history.domain import HistoryEvent
from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import HistoryRow
from backend.serialization import dumps, loads_object


def _to_domain(row: HistoryRow) -> HistoryEvent:
    details = loads_object(row.details_json) if row.details_json else None
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
        self.played: set[str] = set()

    def add(self, event: HistoryEvent) -> None:
        if event.event_type == "SongPlayed" and event.entity_id:
            self.played.add(event.entity_id)
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

    def latest_id(self) -> int:
        return int(self._session.scalar(select(func.max(HistoryRow.id))) or 0)

    def list(
        self,
        *,
        limit: int,
        offset: int,
        event_types: Collection[str] | None = None,
        snapshot: int | None = None,
    ) -> Sequence[HistoryEvent]:
        query = select(HistoryRow)
        if snapshot is not None:
            query = query.where(HistoryRow.id <= snapshot)
        kinds = tuple(dict.fromkeys(event_types)) if event_types is not None else None
        if kinds is not None and len(kinds) > 1:
            # Each type can contribute at most this many rows to the requested page.
            # Bound each ordered index scan before merging; IN (...) would sort every match.
            candidates = min(limit + offset, 2**63 - 1)
            parts = [
                select(
                    query.where(HistoryRow.event_type == kind)
                    .order_by(HistoryRow.created_at.desc(), HistoryRow.event_id)
                    .limit(candidates)
                    .subquery()
                )
                for kind in kinds
            ]
            recent = aliased(HistoryRow, union_all(*parts).subquery())
            query = select(recent).order_by(recent.created_at.desc(), recent.event_id)
        else:
            if kinds is not None:
                query = query.where(HistoryRow.event_type.in_(kinds))
            query = query.order_by(HistoryRow.created_at.desc(), HistoryRow.event_id)
        query = query.limit(limit).offset(offset)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def count(
        self, event_types: Collection[str] | None = None, *, snapshot: int | None = None
    ) -> int:
        query = select(func.count()).select_from(HistoryRow)
        if event_types is not None:
            query = query.where(HistoryRow.event_type.in_(tuple(event_types)))
        if snapshot is not None:
            query = query.where(HistoryRow.id <= snapshot)
        return int(self._session.scalar(query) or 0)
