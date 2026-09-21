from __future__ import annotations

from backend.bootstrap.container import RoomCases
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.room.commands import (
    AuthorizeMediaControl,
    CreateRoom,
    DisconnectParticipant,
    JoinRoom,
    LeaveRoom,
    ResolveHostDisconnect,
    SelectRoomSong,
    SetParticipantReadiness,
)
from backend.room.queries import GetRoom
from backend.runtime import Clock, IdGenerator


def build_room_cases(ids: IdGenerator, clock: Clock) -> RoomCases:
    rooms = InMemoryRoomRepository()
    return RoomCases(
        CreateRoom(rooms, ids),
        GetRoom(rooms),
        JoinRoom(rooms),
        DisconnectParticipant(rooms, clock),
        ResolveHostDisconnect(rooms, clock),
        LeaveRoom(rooms),
        SelectRoomSong(rooms),
        SetParticipantReadiness(rooms),
        AuthorizeMediaControl(rooms),
    )
