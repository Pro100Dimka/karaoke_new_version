from __future__ import annotations

from backend.domain_errors import ForbiddenError, NotFoundError
from backend.room.domain import Room
from backend.room.ports import RoomRepository


def room_member(repository: RoomRepository, room_id: str, participant_id: str) -> Room:
    """The room, when the participant belongs to it."""
    room = repository.get(room_id)
    if room is None:
        raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
    if participant_id not in room.participants:
        raise ForbiddenError("RoomPermissionDenied", "Participant is not in this room")
    return room
