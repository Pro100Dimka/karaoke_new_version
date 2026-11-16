"""Authoritative singer settings shared by the karaoke console and room controls."""

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException
from pydantic import Field

from backend.api.room_routes import ActorDto, ContainerDep, RoomDto, _room
from backend.room.identifiers import normalize_room_id

router = APIRouter(prefix="/rooms")
VoiceSetting = Literal["echo", "reverb", "delay", "autoTune", "noiseSuppression", "voiceGain"]


class VoiceSettingsDto(ActorDto):
    target_participant_id: str = Field(min_length=1, max_length=128)
    settings: dict[VoiceSetting, Annotated[float, Field(ge=0, le=4, allow_inf_nan=False)]]
    initialize: bool = False


@router.post("/{room_id}/voice-settings", response_model=RoomDto)
def update_voice_settings(room_id: str, body: VoiceSettingsDto, app: ContainerDep) -> RoomDto:
    if not body.settings or any(
        value > 1 for key, value in body.settings.items() if key != "voiceGain"
    ):
        raise HTTPException(status_code=422, detail="Effect amounts must be between 0 and 1")
    if body.initialize and len(body.settings) != 6:
        raise HTTPException(
            status_code=422, detail="Initial singer settings must contain all six controls"
        )
    return _room(
        app.rooms.voice_settings.execute(
            normalize_room_id(room_id),
            body.participant_id,
            body.target_participant_id,
            {key: value for key, value in body.settings.items()},
            body.initialize,
        )
    )
