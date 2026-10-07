from __future__ import annotations

from dataclasses import dataclass

from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.room.commands import (
    AuthorizeMediaControl,
    ClearRoomSong,
    SelectRoomSong,
    SetCollaborativeControl,
    SetParticipantReadiness,
    StartRoomSyncCheck,
    PublishRoomLibrary,
    UpdateSharedRoomState,
)
from backend.room.membership_commands import (
    CloseRoom,
    CreateRoom,
    DisconnectParticipant,
    JoinRoom,
    LeaveRoom,
    ResolveHostDisconnect,
    RemoveRoomParticipant,
    TransferRoomHost,
)
from backend.room.timing import SetParticipantTiming
from backend.room.ports import RoomRepository
from backend.room.queries import GetRoom
from backend.room.serialization import RoomLocks
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
    # One set of locks for every command of this server, so any two commands of a room exclude
    # each other.
    locks = RoomLocks()
    return RoomCases(
        CreateRoom(rooms, ids),
        GetRoom(rooms),
        JoinRoom(rooms, locks=locks),
        DisconnectParticipant(rooms, clock, locks=locks),
        ResolveHostDisconnect(rooms, clock, locks=locks),
        LeaveRoom(rooms, locks=locks),
        SelectRoomSong(rooms, clock, locks=locks),
        ClearRoomSong(rooms, locks=locks),
        SetParticipantReadiness(rooms, clock, locks=locks),
        SetParticipantTiming(rooms, clock, locks=locks),
        AuthorizeMediaControl(rooms, clock, locks=locks),
        UpdateSharedRoomState(rooms, clock, locks=locks),
        PublishRoomLibrary(rooms, locks=locks),
        SetCollaborativeControl(rooms, locks=locks),
        StartRoomSyncCheck(rooms, clock, locks=locks),
        TransferRoomHost(rooms, locks=locks),
        RemoveRoomParticipant(rooms, locks=locks),
        CloseRoom(rooms, locks=locks),
    )
