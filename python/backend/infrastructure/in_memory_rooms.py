from __future__ import annotations

import threading

from backend.room.domain import Room


class InMemoryRoomRepository:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._rooms: dict[str, Room] = {}

    def get(self, room_id: str) -> Room | None:
        with self._lock:
            return self._rooms.get(room_id)

    def save(self, room: Room) -> None:
        with self._lock:
            self._rooms[room.room_id] = room

    def delete(self, room_id: str) -> None:
        with self._lock:
            self._rooms.pop(room_id, None)

    def list_ids(self) -> tuple[str, ...]:
        """Room ids to sweep for an expired host-disconnect grace period; not part of the ``RoomRepository`` port."""
        with self._lock:
            return tuple(self._rooms)
