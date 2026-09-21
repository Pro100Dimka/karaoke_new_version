from __future__ import annotations

from typing import Mapping, Protocol


class EventPublisher(Protocol):
    def publish(self, event_type: str, payload: Mapping[str, object]) -> None: ...
