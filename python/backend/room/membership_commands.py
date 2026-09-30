"""Commands that change who is in a room and who hosts it."""

from __future__ import annotations

from dataclasses import replace

from backend.domain_errors import ConflictError, NotFoundError
from backend.room.domain import (
    ConnectionState,
    HostDisconnectPolicy,
    Participant,
    ParticipantRole,
    ReadinessState,
    Room,
)
from backend.room.access import (
    host_room,
    load_room,
)
from backend.room.ports import RoomRepository
from backend.runtime import Clock, IdGenerator


class CreateRoom:
    def __init__(self, rooms: RoomRepository, ids: IdGenerator) -> None:
        self._rooms = rooms
        self._ids = ids

    def execute(
        self,
        participant_id: str,
        display_name: str,
        disconnect_policy: HostDisconnectPolicy,
        host_grace_seconds: float = 10.0,
    ) -> Room:
        host = Participant(
            participant_id,
            display_name,
            ParticipantRole.HOST,
            ConnectionState.CONNECTED,
            ReadinessState.READY,
        )
        room = Room(
            self._ids.new(),
            participant_id,
            {participant_id: host},
            disconnect_policy,
            host_grace_seconds=host_grace_seconds,
        )
        self._rooms.save(room)
        return room


class JoinRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, participant_id: str, display_name: str) -> Room:
        room = load_room(self._rooms, room_id)
        existing = room.participants.get(participant_id)
        role = existing.role if existing else ParticipantRole.PARTICIPANT
        readiness = ReadinessState.MISSING_SONG if room.song_id else ReadinessState.READY
        participant = Participant(
            participant_id, display_name, role, ConnectionState.CONNECTED, readiness
        )
        participants = dict(room.participants)
        participants[participant_id] = participant
        disconnected_at = None if participant_id == room.host_id else room.host_disconnected_at
        updated = replace(room, participants=participants, host_disconnected_at=disconnected_at)
        self._rooms.save(updated)
        return updated


class DisconnectParticipant:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(self, room_id: str, participant_id: str) -> Room:
        room = load_room(self._rooms, room_id)
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants[participant_id] = replace(
            participant,
            connection_state=ConnectionState.DISCONNECTED,
            readiness_state=ReadinessState.DISCONNECTED,
            transfer_progress=0,
        )
        disconnected_at = (
            self._clock.now() if participant_id == room.host_id else room.host_disconnected_at
        )
        updated = replace(room, participants=participants, host_disconnected_at=disconnected_at)
        self._rooms.save(updated)
        return updated


class ResolveHostDisconnect:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(self, room_id: str) -> Room | None:
        room = load_room(self._rooms, room_id)
        disconnected_at = room.host_disconnected_at
        if disconnected_at is None:
            return room
        elapsed = (self._clock.now() - disconnected_at).total_seconds()
        if elapsed < room.host_grace_seconds:
            return room
        connected = {
            key: value
            for key, value in room.participants.items()
            if key != room.host_id and value.connection_state is ConnectionState.CONNECTED
        }
        if room.disconnect_policy is HostDisconnectPolicy.CLOSE or not connected:
            self._rooms.delete(room_id)
            return None
        # Participant mappings preserve join order, including through SQLite serialization.
        # Authority therefore moves to the oldest still-connected participant, not the
        # lexicographically smallest random participant id.
        new_host_id = next(iter(connected))
        participants = dict(room.participants)
        old_host = participants[room.host_id]
        participants[room.host_id] = replace(old_host, role=ParticipantRole.PARTICIPANT)
        participants[new_host_id] = replace(participants[new_host_id], role=ParticipantRole.HOST)
        updated = replace(
            room, host_id=new_host_id, participants=participants, host_disconnected_at=None
        )
        self._rooms.save(updated)
        return updated


class LeaveRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, participant_id: str) -> Room | None:
        room = load_room(self._rooms, room_id)
        participants = dict(room.participants)
        participants.pop(participant_id, None)
        shared_songs = tuple(
            song for song in room.shared_songs if song.owner_participant_id != participant_id
        )
        if participant_id != room.host_id:
            updated = replace(room, participants=participants, shared_songs=shared_songs)
            self._rooms.save(updated)
            return updated
        if room.disconnect_policy is HostDisconnectPolicy.CLOSE or not participants:
            self._rooms.delete(room_id)
            return None
        new_host_id = next(iter(participants))
        participants[new_host_id] = replace(participants[new_host_id], role=ParticipantRole.HOST)
        updated = replace(
            room, host_id=new_host_id, participants=participants, shared_songs=shared_songs
        )
        self._rooms.save(updated)
        return updated


class TransferRoomHost:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str, target_id: str) -> Room:
        room = host_room(self._rooms, room_id, actor_id)
        target = room.participants.get(target_id)
        if target is None or target.connection_state is not ConnectionState.CONNECTED:
            raise NotFoundError(
                "ParticipantNotFound", "The new room host must be a connected participant"
            )
        if target_id == actor_id:
            return room
        participants = dict(room.participants)
        participants[actor_id] = replace(participants[actor_id], role=ParticipantRole.PARTICIPANT)
        participants[target_id] = replace(target, role=ParticipantRole.HOST)
        updated = replace(
            room, host_id=target_id, participants=participants, host_disconnected_at=None
        )
        self._rooms.save(updated)
        return updated


class RemoveRoomParticipant:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str, target_id: str) -> Room:
        room = host_room(self._rooms, room_id, actor_id)
        if target_id == actor_id:
            raise ConflictError("HostCannotRemoveSelf", "Transfer or close the room first")
        if target_id not in room.participants:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants.pop(target_id)
        shared_songs = tuple(
            song for song in room.shared_songs if song.owner_participant_id != target_id
        )
        updated = replace(room, participants=participants, shared_songs=shared_songs)
        self._rooms.save(updated)
        return updated


class CloseRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str) -> None:
        host_room(self._rooms, room_id, actor_id)
        self._rooms.delete(room_id)
