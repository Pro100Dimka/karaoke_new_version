from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from enum import StrEnum

from backend.domain_errors import ConflictError, ForbiddenError, NotFoundError
from backend.room.domain import (
    ConnectionState,
    HostDisconnectPolicy,
    Participant,
    ParticipantRole,
    PlaybackState,
    ReadinessState,
    Room,
)
from backend.room.ports import RoomRepository
from backend.runtime import Clock, IdGenerator


class MediaControlCommand(StrEnum):
    START = "Start"
    PAUSE = "Pause"
    SEEK = "Seek"
    STOP = "Stop"


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
        room = _room(self._rooms, room_id)
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
        room = _room(self._rooms, room_id)
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants[participant_id] = replace(
            participant,
            connection_state=ConnectionState.DISCONNECTED,
            readiness_state=ReadinessState.DISCONNECTED,
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
        room = _room(self._rooms, room_id)
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
        new_host_id = sorted(connected)[0]
        participants = dict(room.participants)
        old_host = participants[room.host_id]
        participants[room.host_id] = replace(old_host, role=ParticipantRole.PARTICIPANT)
        participants[new_host_id] = replace(participants[new_host_id], role=ParticipantRole.HOST)
        updated = replace(
            room, host_id=new_host_id, participants=participants, host_disconnected_at=None
        )
        self._rooms.save(updated)
        return updated


class SelectRoomSong:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str, song_id: str, revision: int) -> Room:
        room = _host_room(self._rooms, room_id, actor_id)
        participants = {
            key: replace(value, readiness_state=ReadinessState.MISSING_SONG)
            for key, value in room.participants.items()
        }
        participants[actor_id] = replace(
            participants[actor_id], readiness_state=ReadinessState.READY
        )
        updated = replace(
            room,
            song_id=song_id,
            revision=revision,
            participants=participants,
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
        )
        self._rooms.save(updated)
        return updated


class SetParticipantReadiness:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, participant_id: str, readiness: ReadinessState) -> Room:
        room = _room(self._rooms, room_id)
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        participants[participant_id] = replace(participant, readiness_state=readiness)
        updated = replace(room, participants=participants)
        self._rooms.save(updated)
        return updated


class AuthorizeMediaControl:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(
        self, room_id: str, actor_id: str, command: MediaControlCommand
    ) -> dict[str, object]:
        room = _host_room(self._rooms, room_id, actor_id)
        if command is MediaControlCommand.START and not _all_ready(room):
            raise ConflictError("RoomNotReady", "Required participants are not ready")
        if command is MediaControlCommand.START:
            room = replace(
                room,
                playback_state=PlaybackState.PLAYING,
                playback_started_at=self._clock.now() + timedelta(seconds=3),
                playback_position_seconds=0.0,
            )
        elif command is MediaControlCommand.PAUSE:
            room = _paused_room(room, self._clock)
        elif command is MediaControlCommand.STOP:
            room = replace(
                room,
                playback_state=PlaybackState.STOPPED,
                playback_started_at=None,
                playback_position_seconds=0.0,
            )
        self._rooms.save(room)
        return {
            "roomId": room.room_id,
            "command": command.value,
            "songId": room.song_id,
            "revision": room.revision,
            "playbackState": room.playback_state.value,
            "playbackStartedAt": room.playback_started_at,
            "playbackPositionSeconds": room.playback_position_seconds,
        }


def _paused_room(room: Room, clock: Clock) -> Room:
    position = room.playback_position_seconds
    if room.playback_state is PlaybackState.PLAYING and room.playback_started_at is not None:
        position += max(0.0, (clock.now() - room.playback_started_at).total_seconds())
    return replace(
        room,
        playback_state=PlaybackState.PAUSED,
        playback_started_at=None,
        playback_position_seconds=position,
    )


class LeaveRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, participant_id: str) -> Room | None:
        room = _room(self._rooms, room_id)
        participants = dict(room.participants)
        participants.pop(participant_id, None)
        if participant_id != room.host_id:
            updated = replace(room, participants=participants)
            self._rooms.save(updated)
            return updated
        if room.disconnect_policy is HostDisconnectPolicy.CLOSE or not participants:
            self._rooms.delete(room_id)
            return None
        new_host_id = sorted(participants)[0]
        participants[new_host_id] = replace(participants[new_host_id], role=ParticipantRole.HOST)
        updated = replace(room, host_id=new_host_id, participants=participants)
        self._rooms.save(updated)
        return updated


def _room(rooms: RoomRepository, room_id: str) -> Room:
    room = rooms.get(room_id)
    if room is None:
        raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
    return room


def _host_room(rooms: RoomRepository, room_id: str, actor_id: str) -> Room:
    room = _room(rooms, room_id)
    host = room.participants.get(room.host_id)
    if (
        room.host_id != actor_id
        or host is None
        or host.connection_state is not ConnectionState.CONNECTED
    ):
        raise ForbiddenError(
            "RoomPermissionDenied", "Only the connected room host may request this command"
        )
    return room


def _all_ready(room: Room) -> bool:
    return bool(room.participants) and all(
        participant.connection_state is ConnectionState.CONNECTED
        and participant.readiness_state is ReadinessState.READY
        for participant in room.participants.values()
    )
