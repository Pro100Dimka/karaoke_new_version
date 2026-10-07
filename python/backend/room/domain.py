from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum
from typing import Mapping

from backend.room.timing_policy import (
    ROOM_TIMING,
    EligibilityReason,
    RoomTiming,
    TimingSource,
    eligibility,
    select_room_timing,
)


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
    # Measured return route (relay to this listener's playout) and the latest arrival at the
    # relay of the voices this listener hears; None while they are calibrating.
    return_requirement_ms: float | None = None
    arrival_requirement_ms: float | None = None
    voice_route_calibrated: bool = False

    @property
    def eligibility_reason(self) -> EligibilityReason:
        return eligibility(self)

    @property
    def voice_eligible(self) -> bool:
        return self.eligibility_reason is EligibilityReason.ELIGIBLE


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
    room_playout_delay_ms: float = ROOM_TIMING.maximum_idle_delay_ms
    room_return_reserve_ms: float = ROOM_TIMING.return_requirement.fallback_ms
    room_timing_source: TimingSource = TimingSource.AWAITING_ROUTES

    def with_timing(self, timing: RoomTiming) -> Room:
        return replace(
            self,
            room_playout_delay_ms=timing.playout_delay_ms,
            room_return_reserve_ms=timing.return_reserve_ms,
            room_timing_source=timing.source,
        )


def room_timing(room: Room) -> RoomTiming:
    """Keep conversation flexible until playback starts; hold its deadline through pause."""
    return select_room_timing(
        (
            participant
            for participant in room.participants.values()
            if participant.connection_state is ConnectionState.CONNECTED
        ),
        song_selected=room.playback_state is not PlaybackState.STOPPED,
    )
