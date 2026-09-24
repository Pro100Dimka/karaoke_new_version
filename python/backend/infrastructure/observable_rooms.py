from __future__ import annotations

import threading
import time

from backend.room.domain import Room
from backend.room.ports import RoomRepository


class ObservableRoomRepository:
    """Adds blocking change notifications without leaking transport concerns into room cases."""

    def __init__(self, inner: RoomRepository) -> None:
        self._inner = inner
        self._condition = threading.Condition()
        self._versions: dict[str, int] = {}

    def get(self, room_id: str) -> Room | None:
        return self._inner.get(room_id)

    def save(self, room: Room) -> None:
        self._inner.save(room)
        self._publish(room.room_id)

    def delete(self, room_id: str) -> None:
        self._inner.delete(room_id)
        self._publish(room_id)

    def list_ids(self) -> tuple[str, ...]:
        list_ids = getattr(self._inner, "list_ids")
        return tuple(list_ids())

    def version(self, room_id: str) -> int:
        with self._condition:
            return self._versions.get(room_id, 0)

    def wait_for_change(self, room_id: str, after: int, timeout: float = 25.0) -> int:
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._versions.get(room_id, 0) <= after:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(remaining)
            return self._versions.get(room_id, 0)

    def _publish(self, room_id: str) -> None:
        with self._condition:
            self._versions[room_id] = self._versions.get(room_id, 0) + 1
            self._condition.notify_all()
