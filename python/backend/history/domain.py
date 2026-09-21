from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Mapping


@dataclass(frozen=True, slots=True)
class HistoryEvent:
    event_id: str
    event_type: str
    created_at: datetime
    entity_type: str | None = None
    entity_id: str | None = None
    details: Mapping[str, object] | None = None
