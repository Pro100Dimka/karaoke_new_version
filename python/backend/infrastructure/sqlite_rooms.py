from __future__ import annotations

import sqlite3
import threading
from datetime import datetime
from pathlib import Path

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
from backend.serialization import dumps, loads_object


class SqliteRoomRepository:
    """Durable single-node room store used by the Oracle deployment."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._lock = threading.Lock()
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS rooms (room_id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def get(self, room_id: str) -> Room | None:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT payload FROM rooms WHERE room_id = ?", (room_id,)
            ).fetchone()
        return None if row is None else _decode_room(str(row[0]))

    def save(self, room: Room) -> None:
        payload = _encode_room(room)
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO rooms(room_id, payload) VALUES (?, ?) "
                "ON CONFLICT(room_id) DO UPDATE SET payload = excluded.payload",
                (room.room_id, payload),
            )

    def delete(self, room_id: str) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("DELETE FROM rooms WHERE room_id = ?", (room_id,))

    def list_ids(self) -> tuple[str, ...]:
        with self._lock, self._connect() as connection:
            rows = connection.execute("SELECT room_id FROM rooms").fetchall()
        return tuple(str(row[0]) for row in rows)


def _encode_room(room: Room) -> str:
    return dumps(
        {
            "roomId": room.room_id,
            "hostId": room.host_id,
            "disconnectPolicy": room.disconnect_policy.value,
            "hostGraceSeconds": room.host_grace_seconds,
            "hostDisconnectedAt": room.host_disconnected_at.isoformat()
            if room.host_disconnected_at
            else None,
            "songId": room.song_id,
            "revision": room.revision,
            "playbackState": room.playback_state.value,
            "playbackStartedAt": room.playback_started_at.isoformat()
            if room.playback_started_at
            else None,
            "playbackPositionSeconds": room.playback_position_seconds,
            "radioEnabled": room.radio_enabled,
            "radioStationId": room.radio_station_id,
            "libraryQuery": room.library_query,
            "libraryStatus": room.library_status,
            "librarySort": room.library_sort,
            "playbackRate": room.playback_rate,
            "keyShift": room.key_shift,
            "sharedSongs": [_encode_song(song) for song in room.shared_songs],
            "participants": [_encode_participant(item) for item in room.participants.values()],
        },
    )


def _encode_song(song: RoomSong) -> dict[str, object]:
    return {
        "ownerParticipantId": song.owner_participant_id, "songId": song.song_id,
        "revision": song.revision, "title": song.title, "artist": song.artist,
        "album": song.album, "genre": song.genre, "durationSeconds": song.duration_seconds,
    }


def _encode_participant(item: Participant) -> dict[str, object]:
    return {
        "participantId": item.participant_id, "displayName": item.display_name,
        "role": item.role.value, "connectionState": item.connection_state.value,
        "readinessState": item.readiness_state.value,
    }


def _decode_songs(raw: dict[str, object]) -> tuple[RoomSong, ...]:
    return tuple(
        RoomSong(str(song["ownerParticipantId"]), str(song["songId"]), int(song["revision"]),
                 str(song["title"]), str(song["artist"]),
                 str(song["album"]) if song.get("album") is not None else None,
                 str(song["genre"]) if song.get("genre") is not None else None,
                 float(song["durationSeconds"]))
        for song in raw.get("sharedSongs", [])
    )


def _decode_room(payload: str) -> Room:
    raw = loads_object(payload)
    participants = {
        item["participantId"]: Participant(
            item["participantId"],
            item["displayName"],
            ParticipantRole(item["role"]),
            ConnectionState(item["connectionState"]),
            ReadinessState(item["readinessState"]),
        )
        for item in raw["participants"]
    }
    return Room(
        room_id=raw["roomId"],
        host_id=raw["hostId"],
        participants=participants,
        disconnect_policy=HostDisconnectPolicy(raw["disconnectPolicy"]),
        host_grace_seconds=float(raw["hostGraceSeconds"]),
        host_disconnected_at=datetime.fromisoformat(raw["hostDisconnectedAt"])
        if raw["hostDisconnectedAt"]
        else None,
        song_id=raw["songId"],
        revision=raw["revision"],
        playback_state=PlaybackState(raw["playbackState"]),
        playback_started_at=datetime.fromisoformat(raw["playbackStartedAt"])
        if raw["playbackStartedAt"]
        else None,
        playback_position_seconds=float(raw["playbackPositionSeconds"]),
        radio_enabled=bool(raw.get("radioEnabled", False)),
        radio_station_id=str(raw.get("radioStationId", "groove-salad")),
        library_query=str(raw.get("libraryQuery", "")),
        library_status=str(raw.get("libraryStatus", "all")),
        library_sort=str(raw.get("librarySort", "recent")),
        playback_rate=float(raw.get("playbackRate", 1.0)),
        key_shift=int(raw.get("keyShift", 0)),
        shared_songs=_decode_songs(raw),
    )
