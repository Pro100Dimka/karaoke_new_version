from __future__ import annotations

from typing import Protocol

from backend.room.domain import Room


class RoomRepository(Protocol):
    def get(self, room_id: str) -> Room | None: ...

    def save(self, room: Room) -> None: ...

    def delete(self, room_id: str) -> None: ...
