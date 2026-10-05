from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from math import ceil
from typing import Mapping


MINIMUM_ROOM_PLAYOUT_DELAY_MS = 10.0
MAXIMUM_LIVE_ROOM_DELAY_MS = 80.0
VOICE_PACKET_DURATION_MS = 2.5


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
    voice_latency_ms: float = 0.0
    voice_timing_ready: bool = False

    @property
    def voice_eligible(self) -> bool:
        return self.voice_timing_ready and self.voice_latency_ms <= MAXIMUM_LIVE_ROOM_DELAY_MS


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
    music_gain: float = 0.82
    reference_gain: float = 0.0
    melody_gain: float = 0.0
    collaborative_control: bool = False
    sync_check_id: int = 0
    sync_check_started_at: datetime | None = None
    shared_songs: tuple[RoomSong, ...] = ()
    room_playout_delay_ms: float = MAXIMUM_LIVE_ROOM_DELAY_MS


def measured_room_playout_delay(participants: Mapping[str, Participant]) -> float:
    """Smallest packet boundary that contains every measured, eligible live route."""
    connected = [
        participant
        for participant in participants.values()
        if participant.connection_state is ConnectionState.CONNECTED
    ]
    if not connected:
        return MINIMUM_ROOM_PLAYOUT_DELAY_MS
    if any(not participant.voice_timing_ready for participant in connected):
        return MAXIMUM_LIVE_ROOM_DELAY_MS
    eligible = [
        participant.voice_latency_ms
        for participant in connected
        if participant.voice_eligible
    ]
    # If every measured route is currently beyond the live ceiling, keep the safest bounded
    # deadline. Falling back to the minimum creates a feedback loop: every packet becomes late,
    # so no route can recover and become eligible again.
    required = max(eligible, default=MAXIMUM_LIVE_ROOM_DELAY_MS)
    bounded = max(MINIMUM_ROOM_PLAYOUT_DELAY_MS, min(MAXIMUM_LIVE_ROOM_DELAY_MS, required))
    return ceil(bounded / VOICE_PACKET_DURATION_MS) * VOICE_PACKET_DURATION_MS
