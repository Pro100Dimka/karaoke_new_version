"""Room lookups and permission checks shared by the room commands."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime

from backend.domain_errors import ForbiddenError, NotFoundError
from backend.room.domain import (
    ConnectionState,
    PlaybackState,
    ReadinessState,
    Room,
)
from backend.room.ports import RoomRepository
from backend.runtime import Clock


def playback_position(room: Room, now: datetime) -> float:
    position = room.playback_position_seconds
    if room.playback_state is PlaybackState.PLAYING and room.playback_started_at is not None:
        position += max(0.0, (now - room.playback_started_at).total_seconds()) * room.playback_rate
    return position


def paused_room(room: Room, clock: Clock) -> Room:
    return replace(
        room,
        playback_state=PlaybackState.PAUSED,
        playback_started_at=None,
        playback_position_seconds=playback_position(room, clock.now()),
    )


def load_room(rooms: RoomRepository, room_id: str) -> Room:
    room = rooms.get(room_id)
    if room is None:
        raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
    return room


def host_room(rooms: RoomRepository, room_id: str, actor_id: str) -> Room:
    room = load_room(rooms, room_id)
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


def member_room(rooms: RoomRepository, room_id: str, actor_id: str) -> Room:
    room = load_room(rooms, room_id)
    participant = room.participants.get(actor_id)
    if participant is None or participant.connection_state is not ConnectionState.CONNECTED:
        raise ForbiddenError(
            "RoomPermissionDenied", "Only a connected room member may update state"
        )
    return room


def controller_room(rooms: RoomRepository, room_id: str, actor_id: str) -> Room:
    room = member_room(rooms, room_id, actor_id)
    if actor_id != room.host_id and not room.collaborative_control:
        raise ForbiddenError("RoomPermissionDenied", "Only the room host may control this room")
    return room


def all_ready(room: Room) -> bool:
    return bool(room.participants) and all(
        participant.connection_state is ConnectionState.CONNECTED
        and participant.readiness_state is ReadinessState.READY
        and participant.voice_timing_ready
        for participant in room.participants.values()
    )


def project_source(room: Room, song_id: str, revision: int) -> str | None:
    """Whose uploaded project of this song revision the room uses: its earliest sharer's.

    Members holding a copy of a song share it too (that is how a room knows they need no
    download); only the original sharer's archive is served, so a copy can never replace it.
    """
    return next(
        (
            song.owner_participant_id
            for song in room.shared_songs
            if song.song_id == song_id and song.revision == revision
        ),
        None,
    )
