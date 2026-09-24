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
    RoomSong,
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


class SelectRoomSong:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str, song_id: str, revision: int) -> Room:
        room = _controller_room(self._rooms, room_id, actor_id)
        owners = {
            song.owner_participant_id
            for song in room.shared_songs
            if song.song_id == song_id and song.revision == revision
        }
        # Older clients can select before their first library publication. In that
        # compatibility case the controller is the only known holder. Once the
        # revision is advertised, its actual owner is authoritative.
        ready_participants = owners or {actor_id}
        participants = {
            key: replace(
                value,
                readiness_state=(
                    ReadinessState.READY
                    if key in ready_participants
                    else ReadinessState.MISSING_SONG
                ),
                transfer_progress=100 if key in ready_participants else 0,
            )
            for key, value in room.participants.items()
        }
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


class ClearRoomSong:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str) -> Room:
        room = _controller_room(self._rooms, room_id, actor_id)
        participants = {
            key: replace(value, readiness_state=ReadinessState.READY, transfer_progress=100)
            for key, value in room.participants.items()
        }
        updated = replace(
            room,
            song_id=None,
            revision=None,
            participants=participants,
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
        )
        self._rooms.save(updated)
        return updated


class SetParticipantReadiness:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(self, room_id: str, participant_id: str, readiness: ReadinessState,
                progress: int | None = None) -> Room:
        room = _room(self._rooms, room_id)
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        transfer_progress = progress if progress is not None else (
            100 if readiness is ReadinessState.READY else participant.transfer_progress
        )
        participants[participant_id] = replace(
            participant,
            readiness_state=readiness,
            transfer_progress=max(0, min(100, transfer_progress)),
        )
        updated = replace(room, participants=participants)
        if (
            updated.song_id is not None
            and updated.playback_state is PlaybackState.STOPPED
            and _all_ready(updated)
        ):
            updated = _apply_media_control(
                updated, MediaControlCommand.START, None, self._clock
            )
        self._rooms.save(updated)
        return updated


class AuthorizeMediaControl:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(
        self,
        room_id: str,
        actor_id: str,
        command: MediaControlCommand,
        position_seconds: float | None = None,
    ) -> Room:
        room = _controller_room(self._rooms, room_id, actor_id)
        if command is MediaControlCommand.START and not _all_ready(room):
            raise ConflictError("RoomNotReady", "Required participants are not ready")
        room = _apply_media_control(room, command, position_seconds, self._clock)
        self._rooms.save(room)
        return room


class StartRoomSyncCheck:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    def execute(self, room_id: str, actor_id: str) -> Room:
        room = _room(self._rooms, room_id)
        participant = room.participants.get(actor_id)
        if participant is None or participant.connection_state is not ConnectionState.CONNECTED:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        updated = replace(
            room,
            sync_check_id=room.sync_check_id + 1,
            sync_check_started_at=self._clock.now() + timedelta(seconds=3),
        )
        self._rooms.save(updated)
        return updated


def _apply_media_control(room: Room, command: MediaControlCommand,
                         position_seconds: float | None, clock: Clock) -> Room:
    if command is MediaControlCommand.START:
        position = room.playback_position_seconds if room.playback_state is PlaybackState.PAUSED else 0.0
        return replace(room, playback_state=PlaybackState.PLAYING,
                       playback_started_at=clock.now() + timedelta(seconds=3),
                       playback_position_seconds=position)
    if command is MediaControlCommand.PAUSE:
        return _paused_room(room, clock)
    if command is MediaControlCommand.STOP:
        return replace(room, playback_state=PlaybackState.STOPPED,
                       playback_started_at=None, playback_position_seconds=0.0)
    position = max(0.0, position_seconds or 0.0)
    started = clock.now() if room.playback_state is PlaybackState.PLAYING else None
    return replace(room, playback_position_seconds=position, playback_started_at=started)


class UpdateSharedRoomState:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(
        self,
        room_id: str,
        participant_id: str,
        *,
        radio_enabled: bool,
        radio_station_id: str,
        library_query: str,
        library_status: str,
        library_sort: str,
        playback_rate: float,
        key_shift: int,
    ) -> Room:
        room = _controller_room(self._rooms, room_id, participant_id)
        updated = replace(
            room,
            radio_enabled=radio_enabled,
            radio_station_id=radio_station_id,
            library_query=library_query,
            library_status=library_status,
            library_sort=library_sort,
            playback_rate=max(0.5, min(1.5, playback_rate)),
            key_shift=max(-12, min(12, key_shift)),
        )
        self._rooms.save(updated)
        return updated


class PublishRoomLibrary:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, participant_id: str, songs: tuple[RoomSong, ...]) -> Room:
        room = _member_room(self._rooms, room_id, participant_id)
        owned = tuple(replace(song, owner_participant_id=participant_id) for song in songs)
        retained = tuple(
            song for song in room.shared_songs if song.owner_participant_id != participant_id
        )
        updated = replace(room, shared_songs=retained + owned)
        self._rooms.save(updated)
        return updated


class SetCollaborativeControl:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    def execute(self, room_id: str, actor_id: str, enabled: bool) -> Room:
        room = _host_room(self._rooms, room_id, actor_id)
        updated = replace(room, collaborative_control=enabled)
        self._rooms.save(updated)
        return updated


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
        room = _host_room(self._rooms, room_id, actor_id)
        target = room.participants.get(target_id)
        if target is None or target.connection_state is not ConnectionState.CONNECTED:
            raise NotFoundError(
                "ParticipantNotFound", "The new room host must be a connected participant"
            )
        if target_id == actor_id:
            return room
        participants = dict(room.participants)
        participants[actor_id] = replace(
            participants[actor_id], role=ParticipantRole.PARTICIPANT
        )
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
        room = _host_room(self._rooms, room_id, actor_id)
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
        _host_room(self._rooms, room_id, actor_id)
        self._rooms.delete(room_id)


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


def _member_room(rooms: RoomRepository, room_id: str, actor_id: str) -> Room:
    room = _room(rooms, room_id)
    participant = room.participants.get(actor_id)
    if participant is None or participant.connection_state is not ConnectionState.CONNECTED:
        raise ForbiddenError("RoomPermissionDenied", "Only a connected room member may update state")
    return room


def _controller_room(rooms: RoomRepository, room_id: str, actor_id: str) -> Room:
    room = _member_room(rooms, room_id, actor_id)
    if actor_id != room.host_id and not room.collaborative_control:
        raise ForbiddenError(
            "RoomPermissionDenied", "Only the room host may control this room"
        )
    return room


def _all_ready(room: Room) -> bool:
    return bool(room.participants) and all(
        participant.connection_state is ConnectionState.CONNECTED
        and participant.readiness_state is ReadinessState.READY
        for participant in room.participants.values()
    )
