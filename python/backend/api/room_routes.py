from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.dependencies import container
from backend.bootstrap.container import ApplicationContainer
from backend.room.commands import MediaControlCommand
from backend.room.domain import HostDisconnectPolicy, ReadinessState, Room

router = APIRouter(prefix="/rooms")
ContainerDep = Annotated[ApplicationContainer, Depends(container)]


class CreateRoomDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)
    disconnect_policy: HostDisconnectPolicy = HostDisconnectPolicy.TRANSFER


class JoinRoomDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)


class ActorDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)


class SelectSongDto(ActorDto):
    song_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(ge=1)


class ReadinessDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    readiness: ReadinessState


class ControlDto(ActorDto):
    command: MediaControlCommand


class RoomDto(ApiModel):
    room_id: str
    host_id: str
    song_id: str | None
    revision: int | None
    participants: list[dict[str, str]]
    playback_state: str
    playback_started_at: datetime | None
    playback_position_seconds: float
    server_now: datetime


@router.post("", response_model=RoomDto, status_code=201)
def create_room(body: CreateRoomDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.create.execute(body.participant_id, body.display_name, body.disconnect_policy)
    )


@router.get("/{room_id}", response_model=RoomDto)
def get_room(room_id: str, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.get.execute(room_id))


@router.post("/{room_id}/join", response_model=RoomDto)
def join_room(room_id: str, body: JoinRoomDto, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.join.execute(room_id, body.participant_id, body.display_name))


@router.post("/{room_id}/disconnect", response_model=RoomDto)
def disconnect(room_id: str, body: ActorDto, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.disconnect.execute(room_id, body.participant_id))


@router.post("/{room_id}/resolve-host", response_model=RoomDto | None)
def resolve_host_disconnect(room_id: str, app: ContainerDep) -> RoomDto | None:
    room = app.rooms.resolve_host_disconnect.execute(room_id)
    return _room(room) if room else None


@router.post("/{room_id}/leave", response_model=RoomDto | None)
def leave_room(room_id: str, body: ActorDto, app: ContainerDep) -> RoomDto | None:
    room = app.rooms.leave.execute(room_id, body.participant_id)
    return _room(room) if room else None


@router.post("/{room_id}/song", response_model=RoomDto)
def select_song(room_id: str, body: SelectSongDto, app: ContainerDep) -> RoomDto:
    return _room(
        app.rooms.select_song.execute(room_id, body.participant_id, body.song_id, body.revision)
    )


@router.post("/{room_id}/readiness", response_model=RoomDto)
def readiness(room_id: str, body: ReadinessDto, app: ContainerDep) -> RoomDto:
    return _room(app.rooms.set_readiness.execute(room_id, body.participant_id, body.readiness))


@router.post("/{room_id}/control")
def control(room_id: str, body: ControlDto, app: ContainerDep) -> dict[str, object]:
    return app.rooms.authorize_control.execute(room_id, body.participant_id, body.command)


def _room(room: Room) -> RoomDto:
    participants = [
        {
            "participantId": item.participant_id,
            "displayName": item.display_name,
            "role": item.role.value,
            "connectionState": item.connection_state.value,
            "readinessState": item.readiness_state.value,
        }
        for item in room.participants.values()
    ]
    return RoomDto(
        room_id=room.room_id,
        host_id=room.host_id,
        song_id=room.song_id,
        revision=room.revision,
        participants=participants,
        playback_state=room.playback_state.value,
        playback_started_at=room.playback_started_at,
        playback_position_seconds=room.playback_position_seconds,
        server_now=datetime.now(UTC),
    )
