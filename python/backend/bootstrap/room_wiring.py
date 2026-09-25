from __future__ import annotations

from dataclasses import dataclass

from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.room.commands import (
    AuthorizeMediaControl,
    ClearRoomSong,
    CloseRoom,
    CreateRoom,
    DisconnectParticipant,
    JoinRoom,
    LeaveRoom,
    ResolveHostDisconnect,
    RemoveRoomParticipant,
    SelectRoomSong,
    SetCollaborativeControl,
    SetParticipantReadiness,
    StartRoomSyncCheck,
    TransferRoomHost,
    PublishRoomLibrary,
    UpdateSharedRoomState,
)
from backend.room.timing import SetParticipantTiming
from backend.room.ports import RoomRepository
from backend.room.queries import GetRoom
from backend.runtime import Clock, IdGenerator


@dataclass(frozen=True, slots=True)
class RoomCases:
    create: CreateRoom
    get: GetRoom
    join: JoinRoom
    disconnect: DisconnectParticipant
    resolve_host_disconnect: ResolveHostDisconnect
    leave: LeaveRoom
    select_song: SelectRoomSong
    clear_song: ClearRoomSong
    set_readiness: SetParticipantReadiness
    set_timing: SetParticipantTiming
    authorize_control: AuthorizeMediaControl
    update_shared_state: UpdateSharedRoomState
    publish_library: PublishRoomLibrary
    set_collaborative_control: SetCollaborativeControl
    start_sync_check: StartRoomSyncCheck
    transfer_host: TransferRoomHost
    remove_participant: RemoveRoomParticipant
    close: CloseRoom


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
        SelectRoomSong(rooms, clock),
        ClearRoomSong(rooms),
        SetParticipantReadiness(rooms, clock),
        SetParticipantTiming(rooms),
        AuthorizeMediaControl(rooms, clock),
        UpdateSharedRoomState(rooms, clock),
        PublishRoomLibrary(rooms),
        SetCollaborativeControl(rooms),
        StartRoomSyncCheck(rooms, clock),
        TransferRoomHost(rooms),
        RemoveRoomParticipant(rooms),
        CloseRoom(rooms),
    )
