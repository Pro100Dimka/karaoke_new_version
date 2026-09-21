from __future__ import annotations

from backend.domain_errors import NotFoundError
from backend.room.domain import Room
from backend.room.ports import RoomRepository


class GetRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str) -> Room:
        room = self._rooms.get(room_id)
        if room is None:
            raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
        return room
