"""Commands that drive a room's song, playback and shared state."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from enum import StrEnum

from backend.domain_errors import ConflictError, NotFoundError
from backend.room.serialization import serialized_by_room
from backend.room.domain import (
    ConnectionState,
    PlaybackState,
    ReadinessState,
    Room,
    RoomSong,
)
from backend.room.access import (
    all_ready,
    controller_room,
    host_room,
    load_room,
    member_room,
    paused_room,
    playback_position,
)
from backend.room.ports import RoomRepository
from backend.runtime import Clock


class MediaControlCommand(StrEnum):
    START = "Start"
    PAUSE = "Pause"
    SEEK = "Seek"
    STOP = "Stop"


class SelectRoomSong:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str, song_id: str, revision: int) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
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
                    ReadinessState.PREPARING
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

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
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

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        participant_id: str,
        readiness: ReadinessState,
        progress: int | None = None,
    ) -> Room:
        room = load_room(self._rooms, room_id)
        participant = room.participants.get(participant_id)
        if participant is None:
            raise NotFoundError("ParticipantNotFound", "Room participant was not found")
        participants = dict(room.participants)
        transfer_progress = (
            progress
            if progress is not None
            else (100 if readiness is ReadinessState.READY else participant.transfer_progress)
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
            and all_ready(updated)
        ):
            updated = _apply_media_control(updated, MediaControlCommand.START, None, self._clock)
        self._rooms.save(updated)
        return updated


class AuthorizeMediaControl:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    @serialized_by_room
    def execute(
        self,
        room_id: str,
        actor_id: str,
        command: MediaControlCommand,
        position_seconds: float | None = None,
    ) -> Room:
        room = controller_room(self._rooms, room_id, actor_id)
        if command is MediaControlCommand.START and not all_ready(room):
            raise ConflictError("RoomNotReady", "Required participants are not ready")
        room = _apply_media_control(room, command, position_seconds, self._clock)
        self._rooms.save(room)
        return room


class StartRoomSyncCheck:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str) -> Room:
        room = load_room(self._rooms, room_id)
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


def _apply_media_control(
    room: Room, command: MediaControlCommand, position_seconds: float | None, clock: Clock
) -> Room:
    if command is MediaControlCommand.START:
        position = (
            room.playback_position_seconds if room.playback_state is PlaybackState.PAUSED else 0.0
        )
        return replace(
            room,
            playback_state=PlaybackState.PLAYING,
            playback_started_at=clock.now() + timedelta(seconds=3),
            playback_position_seconds=position,
        )
    if command is MediaControlCommand.PAUSE:
        return paused_room(room, clock)
    if command is MediaControlCommand.STOP:
        return replace(
            room,
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
        )
    position = max(0.0, position_seconds or 0.0)
    started = clock.now() if room.playback_state is PlaybackState.PLAYING else None
    return replace(room, playback_position_seconds=position, playback_started_at=started)


class UpdateSharedRoomState:
    def __init__(self, rooms: RoomRepository, clock: Clock) -> None:
        self._rooms = rooms
        self._clock = clock

    @serialized_by_room
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
        music_gain: float,
        reference_gain: float,
        melody_gain: float,
    ) -> Room:
        room = controller_room(self._rooms, room_id, participant_id)
        rate = max(0.5, min(1.5, playback_rate))
        updated = replace(
            _retimed_for_rate(room, rate, self._clock),
            radio_enabled=radio_enabled,
            radio_station_id=radio_station_id,
            library_query=library_query,
            library_status=library_status,
            library_sort=library_sort,
            playback_rate=rate,
            key_shift=max(-12, min(12, key_shift)),
            music_gain=max(0.0, min(1.0, music_gain)),
            reference_gain=max(0.0, min(1.0, reference_gain)),
            melody_gain=max(0.0, min(1.0, melody_gain)),
        )
        self._rooms.save(updated)
        return updated


def _retimed_for_rate(room: Room, rate: float, clock: Clock) -> Room:
    """A tempo change while playing restarts the position clock from where the song is now."""
    if (
        rate == room.playback_rate
        or room.playback_state is not PlaybackState.PLAYING
        or room.playback_started_at is None
    ):
        return room
    now = clock.now()
    return replace(
        room,
        playback_position_seconds=playback_position(room, now),
        playback_started_at=max(now, room.playback_started_at),
    )


class PublishRoomLibrary:
    def __init__(self, rooms: RoomRepository) -> None:
        self._rooms = rooms

    @serialized_by_room
    def execute(self, room_id: str, participant_id: str, songs: tuple[RoomSong, ...]) -> Room:
        room = member_room(self._rooms, room_id, participant_id)
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

    @serialized_by_room
    def execute(self, room_id: str, actor_id: str, enabled: bool) -> Room:
        room = host_room(self._rooms, room_id, actor_id)
        updated = replace(room, collaborative_control=enabled)
        self._rooms.save(updated)
        return updated
