from __future__ import annotations

from backend.bootstrap.container import RoomCases
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.room.commands import (
    AuthorizeMediaControl,
    ClearRoomSong,
    CreateRoom,
    DisconnectParticipant,
    JoinRoom,
    LeaveRoom,
    ResolveHostDisconnect,
    SelectRoomSong,
    SetParticipantReadiness,
    PublishRoomLibrary,
    UpdateSharedRoomState,
)
from backend.room.ports import RoomRepository
from backend.room.queries import GetRoom
from backend.runtime import Clock, IdGenerator


def build_room_cases(
    ids: IdGenerator, clock: Clock, rooms: RoomRepository | None = None
) -> RoomCases:
    rooms = rooms if rooms is not None else InMemoryRoomRepository()
    return RoomCases(
        CreateRoom(rooms, ids),
        GetRoom(rooms),
        JoinRoom(rooms),
        DisconnectParticipant(rooms, clock),
        ResolveHostDisconnect(rooms, clock),
        LeaveRoom(rooms),
        SelectRoomSong(rooms),
        ClearRoomSong(rooms),
        SetParticipantReadiness(rooms),
        AuthorizeMediaControl(rooms, clock),
        UpdateSharedRoomState(rooms),
        PublishRoomLibrary(rooms),
    )
