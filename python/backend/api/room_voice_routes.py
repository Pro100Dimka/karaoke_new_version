"""The voice relay's control routes: joining a room's voice, its mix and personal gains."""

from __future__ import annotations

from fastapi import FastAPI, Response
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.room_server_access import room_member
from backend.domain_errors import ForbiddenError, NotFoundError
from backend.infrastructure.voice_relay import VoiceRelay
from backend.room.identifiers import normalize_room_id
from backend.room.ports import RoomRepository


class VoiceJoinDto(ApiModel):
    room_id: str = Field(min_length=1, max_length=128)
    participant_id: str = Field(min_length=1, max_length=128)
    machine_id: str = Field(default="", max_length=128)


class VoiceLeaveDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)


class VoiceJoinResponse(ApiModel):
    voice_token: str


class VoiceCandidateDto(VoiceJoinDto):
    voice_token: str = Field(pattern=r"^[0-9a-fA-F]{16}$")
    local_port: int = Field(ge=1, le=65535)
    # Home-network addresses of the voice socket; older clients send none.
    local_hosts: list[str] = Field(default_factory=list, max_length=8)


class VoicePeersDto(VoiceJoinDto):
    voice_token: str = Field(pattern=r"^[0-9a-fA-F]{16}$")


class VoiceParticipantGainDto(VoicePeersDto):
    source_participant_id: str = Field(min_length=1, max_length=128)
    gain: float = Field(ge=0.0, le=2.0)


class VoicePeer(ApiModel):
    participant_id: str
    host: str
    port: int
    voice_token: str


class VoicePeersResponse(ApiModel):
    peers: list[VoicePeer]


def add_voice_routes(app: FastAPI, relay: VoiceRelay, repository: RoomRepository) -> None:
    _add_session_routes(app, relay, repository)
    _add_mix_routes(app, relay, repository)


def _authenticated_room(relay: VoiceRelay, repository: RoomRepository, body: VoicePeersDto) -> str:
    """The normalized room id, when the caller is a member holding its current voice session."""
    room_id = normalize_room_id(body.room_id)
    room_member(repository, room_id, body.participant_id)
    if not relay.authenticates(room_id, body.participant_id, int(body.voice_token, 16)):
        raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token is invalid")
    return room_id


def _add_session_routes(app: FastAPI, relay: VoiceRelay, repository: RoomRepository) -> None:
    @app.post("/voice/join", response_model=VoiceJoinResponse)
    def voice_join(body: VoiceJoinDto) -> VoiceJoinResponse:
        room_id = normalize_room_id(body.room_id)
        room = repository.get(room_id)
        if room is None:
            raise NotFoundError("RoomNotFound", "Room was not found", roomId=body.room_id)
        if body.participant_id not in room.participants:
            raise NotFoundError(
                "ParticipantNotFound",
                "Room participant was not found",
                participantId=body.participant_id,
            )
        token = relay.expect(room_id, body.participant_id, machine_id=body.machine_id)
        return VoiceJoinResponse(voice_token=f"{token:016x}")

    @app.post("/voice/candidate", status_code=204)
    def voice_candidate(body: VoiceCandidateDto) -> Response:
        room_id = normalize_room_id(body.room_id)
        room_member(repository, room_id, body.participant_id)
        token = int(body.voice_token, 16)
        accepted = relay.register_local_port(
            room_id, body.participant_id, token, body.local_port, tuple(body.local_hosts)
        )
        if not accepted:
            raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token is invalid")
        return Response(status_code=204)

    @app.post("/voice/leave", status_code=204)
    def voice_leave(body: VoiceLeaveDto) -> None:
        relay.forget(body.participant_id)


def _add_mix_routes(app: FastAPI, relay: VoiceRelay, repository: RoomRepository) -> None:
    @app.post("/voice/peers", response_model=VoicePeersResponse)
    def voice_peers(body: VoicePeersDto) -> VoicePeersResponse:
        room_id = _authenticated_room(relay, repository, body)
        peers = relay.direct_peers(room_id, body.participant_id, int(body.voice_token, 16))
        return VoicePeersResponse(peers=[VoicePeer.model_validate(peer) for peer in peers])

    @app.post("/voice/metrics")
    def voice_metrics(body: VoicePeersDto) -> dict[str, object]:
        return relay.mix_metrics(_authenticated_room(relay, repository, body))

    @app.post("/voice/levels")
    def voice_levels(body: VoicePeersDto) -> dict[str, float]:
        return relay.participant_levels(_authenticated_room(relay, repository, body))

    @app.post("/voice/participant-gain", status_code=204)
    def voice_participant_gain(body: VoiceParticipantGainDto) -> Response:
        room_id = normalize_room_id(body.room_id)
        room_member(repository, room_id, body.participant_id)
        room_member(repository, room_id, body.source_participant_id)
        if not relay.set_recipient_source_gain(
            room_id,
            body.participant_id,
            int(body.voice_token, 16),
            body.source_participant_id,
            body.gain,
        ):
            raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token or participant is invalid")
        return Response(status_code=204)
