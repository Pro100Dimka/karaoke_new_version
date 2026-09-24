from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum
from typing import Mapping


class ParticipantRole(StrEnum):
    HOST = "Host"
    PARTICIPANT = "Participant"


class ConnectionState(StrEnum):
    CONNECTED = "Connected"
    DISCONNECTED = "Disconnected"


class ReadinessState(StrEnum):
    MISSING_SONG = "MissingSong"
    DOWNLOADING = "Downloading"
    IMPORTING = "Importing"
    PREPARING = "Preparing"
    READY = "Ready"
    FAILED = "Failed"
    DISCONNECTED = "Disconnected"


class HostDisconnectPolicy(StrEnum):
    TRANSFER = "Transfer"
    CLOSE = "Close"


class PlaybackState(StrEnum):
    STOPPED = "Stopped"
    PLAYING = "Playing"
    PAUSED = "Paused"


@dataclass(frozen=True, slots=True)
class Participant:
    participant_id: str
    display_name: str
    role: ParticipantRole
    connection_state: ConnectionState
    readiness_state: ReadinessState
    transfer_progress: int = 100


@dataclass(frozen=True, slots=True)
class RoomSong:
    owner_participant_id: str
    song_id: str
    revision: int
    title: str
    artist: str
    album: str | None
    genre: str | None
    duration_seconds: float


@dataclass(frozen=True, slots=True)
class Room:
    room_id: str
    host_id: str
    participants: Mapping[str, Participant]
    disconnect_policy: HostDisconnectPolicy
    host_grace_seconds: float = 10.0
    host_disconnected_at: datetime | None = None
    song_id: str | None = None
    revision: int | None = None
    playback_state: PlaybackState = PlaybackState.STOPPED
    playback_started_at: datetime | None = None
    playback_position_seconds: float = 0.0
    radio_enabled: bool = False
    radio_station_id: str = "groove-salad"
    library_query: str = ""
    library_status: str = "all"
    library_sort: str = "recent"
    playback_rate: float = 1.0
    key_shift: int = 0
    collaborative_control: bool = False
    sync_check_id: int = 0
    sync_check_started_at: datetime | None = None
    shared_songs: tuple[RoomSong, ...] = ()

    def with_song(self, song_id: str, revision: int) -> "Room":
        return replace(
            self,
            song_id=song_id,
            revision=revision,
            playback_state=PlaybackState.STOPPED,
            playback_started_at=None,
            playback_position_seconds=0.0,
        )
