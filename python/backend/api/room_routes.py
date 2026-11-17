from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal, Protocol

from fastapi import APIRouter, Depends, Response
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.room_participant_dto import RoomParticipantDto, room_participant
from backend.api.dependencies import container
from backend.bootstrap.room_wiring import RoomCases
from backend.room.commands import MediaControlCommand
from backend.room.domain import (
    HostDisconnectPolicy,
    ReadinessState,
    Room,
    RoomPerformanceResult,
    RoomPlaylist,
    RoomSong,
)
from backend.room.identifiers import normalize_room_id
from backend.room.performance import group_performance_accuracy, performance_result

router = APIRouter(prefix="/rooms")


class RoomContainer(Protocol):
    rooms: RoomCases


ContainerDep = Annotated[RoomContainer, Depends(container)]


class CreateRoomDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)
    disconnect_policy: HostDisconnectPolicy = HostDisconnectPolicy.TRANSFER


class JoinRoomDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)


class ActorDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)


class CollaborativeControlDto(ActorDto):
    enabled: bool


class TransferHostDto(ActorDto):
    target_participant_id: str = Field(min_length=1, max_length=128)


class SelectSongDto(ActorDto):
    song_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(ge=1)


class ReadinessDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    readiness: ReadinessState
    selection_id: int = Field(ge=0)
    progress: int | None = Field(default=None, ge=0, le=100)


class PlaylistSongDto(ApiModel):
    song_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(ge=1)


class PlaylistDto(ApiModel):
    name: str = Field(min_length=1, max_length=100)
    songs: list[PlaylistSongDto] = Field(min_length=1, max_length=200)
    index: int = Field(default=0, ge=0)


class StartPlaylistDto(ActorDto):
    name: str = Field(min_length=1, max_length=100)
    songs: list[PlaylistSongDto] = Field(min_length=1, max_length=200)


class AdvancePlaylistDto(ActorDto):
    performance_id: int = Field(ge=0)


class TimingDto(ActorDto):
    voice_latency_ms: float = Field(ge=0, le=500)
    voice_route: Literal["relay", "direct"] = "relay"
    route_calibrated: bool = True
    # Absent while this listener's return route is still calibrating (and from older clients).
    return_requirement_ms: float | None = Field(default=None, ge=0, le=500)
    arrival_requirement_ms: float | None = Field(default=None, ge=0, le=500)


class ControlDto(ActorDto):
    command: MediaControlCommand
    position_seconds: float | None = Field(default=None, ge=0)
    continue_playlist: bool = False


class SharedRoomStateDto(ActorDto):
    radio_enabled: bool
    radio_station_id: str = Field(min_length=1, max_length=128)
    library_query: str = Field(max_length=300)
    library_status: str = Field(min_length=1, max_length=64)
    library_sort: str = Field(min_length=1, max_length=64)
    playback_rate: float = Field(default=1.0, ge=0.5, le=1.5)
    key_shift: int = Field(default=0, ge=-12, le=12)
    music_gain: float = Field(default=0.82, ge=0, le=1)
    reference_gain: float = Field(default=0, ge=0, le=1)
    melody_gain: float = Field(default=0, ge=0, le=1)


class RoomSongDto(ApiModel):
    owner_participant_id: str = ""
    song_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=300)
    artist: str = Field(max_length=300)
    album: str | None = Field(default=None, max_length=300)
    genre: str | None = Field(default=None, max_length=300)
    duration_seconds: float = Field(ge=0)
    source_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    project_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class PublishLibraryDto(ActorDto):
    songs: list[RoomSongDto] = Field(max_length=1000)


class RoomDto(ApiModel):
    performance_results: dict[str, RoomPerformanceResult] = Field(default_factory=dict)
    playlist: PlaylistDto | None = None
    room_id: str
    host_id: str
    song_id: str | None
    revision: int | None
    participants: list[RoomParticipantDto]
    playback_state: str
    playback_started_at: datetime | None
    playback_position_seconds: float
    server_now: datetime
    radio_enabled: bool
    radio_station_id: str
    library_query: str
    library_status: str
    library_sort: str
    playback_rate: float
    key_shift: int
    music_gain: float
    reference_gain: float
    melody_gain: float
    collaborative_control: bool
    sync_check_id: int
    sync_check_started_at: datetime | None
    shared_songs: list[RoomSongDto]
    transfer_progress: int
    room_playout_delay_ms: float = Field(ge=0, le=250)
    room_return_reserve_ms: float = Field(ge=0, le=250)
    room_timing_source: str
    performance_id: int = 0
    selection_id: int = 0
    performance_accuracy: float | None = None
    last_performance_id: int | None = None
    last_performance_accuracy: float | None = None


class RoomPerformanceDto(ActorDto):
    finished: bool = False
    performance_id: int = Field(ge=0)
    accuracy: float = Field(ge=0, le=100, allow_inf_nan=False, strict=True)
    sung_seconds: float = Field(ge=0, le=86400, allow_inf_nan=False, strict=True)


@router.post("/{room_id}/performance", status_code=204)
def publish_performance(room_id: str, body: RoomPerformanceDto, app: ContainerDep) -> Response:
    app.rooms.publish_performance.execute(
        normalize_room_id(room_id),
        body.participant_id,
        body.performance_id,
        body.accuracy,
        body.sung_seconds,
        body.finished,
    )
    return Response(status_code=204)


@router.post("/{room_id}/playlist", response_model=RoomDto)
def start_playlist(room_id: str, body: StartPlaylistDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.playlist.execute(
            normalize_room_id(room_id),
            body.participant_id,
            body.name,
            tuple((song.song_id, song.revision) for song in body.songs),
        )
    )


@router.post("/{room_id}/playlist/next", response_model=RoomDto)
def advance_playlist(room_id: str, body: AdvancePlaylistDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.playlist.advance(
            normalize_room_id(room_id),
            body.participant_id,
            body.performance_id,
        )
    )


@router.post("", response_model=RoomDto, status_code=201)
def create_room(body: CreateRoomDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.create.execute(body.participant_id, body.display_name, body.disconnect_policy)
    )


@router.get("/{room_id}", response_model=RoomDto)
def get_room(room_id: str, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.get.execute(normalize_room_id(room_id)))


@router.post("/{room_id}/join", response_model=RoomDto)
def join_room(room_id: str, body: JoinRoomDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.join.execute(normalize_room_id(room_id), body.participant_id, body.display_name)
    )


@router.post("/{room_id}/disconnect", response_model=RoomDto)
def disconnect(room_id: str, body: ActorDto, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.disconnect.execute(normalize_room_id(room_id), body.participant_id))


@router.post("/{room_id}/resolve-host", response_model=RoomDto | None)
def resolve_host_disconnect(room_id: str, app: ContainerDep) -> RoomDto | None:
    room = app.rooms.resolve_host_disconnect.execute(normalize_room_id(room_id))
    return _room(room) if room else None


@router.post("/{room_id}/leave", response_model=RoomDto | None)
def leave_room(room_id: str, body: ActorDto, app: ContainerDep) -> RoomDto | None:
    room = app.rooms.leave.execute(normalize_room_id(room_id), body.participant_id)
    return _room(room) if room else None


@router.post("/{room_id}/host", response_model=RoomDto)
def transfer_host(room_id: str, body: TransferHostDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.transfer_host.execute(
            normalize_room_id(room_id), body.participant_id, body.target_participant_id
        )
    )


@router.post("/{room_id}/participants/{target_id}/remove", response_model=RoomDto)
def remove_participant(room_id: str, target_id: str, body: ActorDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.remove_participant.execute(
            normalize_room_id(room_id), body.participant_id, target_id
        )
    )


@router.post("/{room_id}/close", status_code=204)
def close_room(room_id: str, body: ActorDto, app: ContainerDep) -> None:
    app.rooms.close.execute(normalize_room_id(room_id), body.participant_id)


@router.post("/{room_id}/song", response_model=RoomDto)
def select_song(room_id: str, body: SelectSongDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.select_song.execute(
            normalize_room_id(room_id), body.participant_id, body.song_id, body.revision
        )
    )


@router.post("/{room_id}/song/clear", response_model=RoomDto)
def clear_song(room_id: str, body: ActorDto, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.clear_song.execute(normalize_room_id(room_id), body.participant_id))


@router.post("/{room_id}/readiness", response_model=RoomDto)
def readiness(room_id: str, body: ReadinessDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.set_readiness.execute(
            normalize_room_id(room_id),
            body.participant_id,
            body.readiness,
            body.progress,
            selection_id=body.selection_id,
        )
    )


@router.post("/{room_id}/timing", response_model=RoomDto)
def timing(room_id: str, body: TimingDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.set_timing.execute(
            normalize_room_id(room_id),
            body.participant_id,
            body.voice_latency_ms,
            body.return_requirement_ms,
            body.arrival_requirement_ms,
            body.route_calibrated,
            body.voice_route,
        )
    )


@router.post("/{room_id}/control", response_model=RoomDto)
def control(room_id: str, body: ControlDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.authorize_control.execute(
            normalize_room_id(room_id),
            body.participant_id,
            body.command,
            body.position_seconds,
            body.continue_playlist,
        )
    )


@router.post("/{room_id}/sync-check", response_model=RoomDto)
def start_sync_check(room_id: str, body: ActorDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.start_sync_check.execute(normalize_room_id(room_id), body.participant_id)
    )


@router.post("/{room_id}/shared-state", response_model=RoomDto)
def update_shared_state(room_id: str, body: SharedRoomStateDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.update_shared_state.execute(
            normalize_room_id(room_id),
            body.participant_id,
            radio_enabled=body.radio_enabled,
            radio_station_id=body.radio_station_id,
            library_query=body.library_query,
            library_status=body.library_status,
            library_sort=body.library_sort,
            playback_rate=body.playback_rate,
            key_shift=body.key_shift,
            music_gain=body.music_gain,
            reference_gain=body.reference_gain,
            melody_gain=body.melody_gain,
        )
    )


@router.post("/{room_id}/library", response_model=RoomDto)
def publish_library(room_id: str, body: PublishLibraryDto, app: ContainerDep) -> RoomDto:
    songs = tuple(
        RoomSong(
            body.participant_id,
            song.song_id,
            song.revision,
            song.title,
            song.artist,
            song.album,
            song.genre,
            song.duration_seconds,
            song.source_hash,
            song.project_hash,
        )
        for song in body.songs
    )
    return _room(
        app.rooms.publish_library.execute(normalize_room_id(room_id), body.participant_id, songs)
    )


def _room_playlist(playlist: RoomPlaylist | None) -> PlaylistDto | None:
    if playlist is None:
        return None
    return PlaylistDto(
        name=playlist.name,
        index=playlist.index,
        songs=[
            PlaylistSongDto(song_id=song_id, revision=revision)
            for song_id, revision in playlist.songs
        ],
    )


def _room(room: Room) -> RoomDto:
    return RoomDto(
        playlist=_room_playlist(room.playlist),
        room_id=room.room_id,
        performance_id=room.performance_id,
        selection_id=room.selection_id,
        performance_accuracy=group_performance_accuracy(room),
        last_performance_id=room.last_performance_id,
        last_performance_accuracy=room.last_performance_accuracy,
        performance_results={
            str(identifier): performance_result(room, identifier)
            for identifier in {*room.performance_history, room.performance_id}
        },
        host_id=room.host_id,
        song_id=room.song_id,
        revision=room.revision,
        participants=[room_participant(item) for item in room.participants.values()],
        playback_state=room.playback_state.value,
        playback_started_at=room.playback_started_at,
        playback_position_seconds=room.playback_position_seconds,
        server_now=datetime.now(UTC),
        radio_enabled=room.radio_enabled,
        radio_station_id=room.radio_station_id,
        library_query=room.library_query,
        library_status=room.library_status,
        library_sort=room.library_sort,
        playback_rate=room.playback_rate,
        key_shift=room.key_shift,
        music_gain=room.music_gain,
        reference_gain=room.reference_gain,
        melody_gain=room.melody_gain,
        collaborative_control=room.collaborative_control,
        sync_check_id=room.sync_check_id,
        sync_check_started_at=room.sync_check_started_at,
        shared_songs=[_room_song(song) for song in room.shared_songs],
        room_playout_delay_ms=room.room_playout_delay_ms,
        room_return_reserve_ms=room.room_return_reserve_ms,
        room_timing_source=room.room_timing_source.value,
        transfer_progress=_transfer_progress(room),
    )


def _transfer_progress(room: Room) -> int:
    return min(
        (
            item.transfer_progress
            for item in room.participants.values()
            if item.connection_state.value == "Connected"
        ),
        default=100,
    )


@router.post("/{room_id}/collaborative-control", response_model=RoomDto)
def set_collaborative_control(
    room_id: str, body: CollaborativeControlDto, app: ContainerDep
) -> RoomDto:
    return _room(
        app.rooms.set_collaborative_control.execute(
            normalize_room_id(room_id), body.participant_id, body.enabled
        )
    )


def _room_song(song: RoomSong) -> RoomSongDto:
    return RoomSongDto(
        owner_participant_id=song.owner_participant_id,
        song_id=song.song_id,
        revision=song.revision,
        title=song.title,
        artist=song.artist,
        album=song.album,
        genre=song.genre,
        duration_seconds=song.duration_seconds,
        source_hash=song.source_hash,
        project_hash=song.project_hash,
    )
