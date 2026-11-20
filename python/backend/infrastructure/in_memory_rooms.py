from __future__ import annotations

import threading
from dataclasses import replace

from backend.room.domain import Room


class InMemoryRoomRepository:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rooms: dict[str, Room] = {}
        self._snapshot_revision = 0

    def get(self, room_id: str) -> Room | None:
        with self._lock:
            return self._rooms.get(room_id)

    def save(self, room: Room) -> Room:
        with self._lock:
            current = self._rooms.get(room.room_id)
            # Participant order determines host failover, so it is part of the snapshot too.
            if (
                current is not None
                and tuple(current.participants) == tuple(room.participants)
                and current == replace(room, snapshot_revision=current.snapshot_revision)
            ):
                return current
            self._snapshot_revision += 1
            saved = replace(room, snapshot_revision=self._snapshot_revision)
            self._rooms[room.room_id] = saved
            return saved

    def delete(self, room_id: str) -> None:
        with self._lock:
            self._rooms.pop(room_id, None)

    def list_ids(self) -> tuple[str, ...]:
        """Room ids to sweep for an expired host-disconnect grace period; not part of the ``RoomRepository`` port."""
        with self._lock:
            return tuple(self._rooms)
