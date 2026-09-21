from __future__ import annotations

from datetime import UTC, datetime


def as_utc(value: datetime) -> datetime:
    """Restores UTC awareness lost by SQLite's timezone-naive datetime storage."""
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def optional_utc(value: datetime | None) -> datetime | None:
    return as_utc(value) if value is not None else None
