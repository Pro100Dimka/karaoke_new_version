"""Room members' audio numbers, logged beside the relay's own view so every computer can be compared."""

from __future__ import annotations

import hmac
from datetime import datetime, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import Field, ValidationError

from backend.api.base_dto import ApiModel
from backend.api.room_identity import ROOM_KEY_HEADER, participant_id_for
from backend.api.room_server_access import room_member
from backend.infrastructure.room_diagnostics import ProgramLog, RoomDiagnosticsLog
from backend.infrastructure.voice_relay import VoiceRelay
from backend.room.domain import Room
from backend.room.identifiers import normalize_room_id
from backend.room.ports import RoomRepository
from backend.room.timing_policy import ROOM_TIMING
from backend.serialization import dumps

_MAX_UPLOAD_BYTES = 512 * 1024

# Client diagnostic name -> the relay metric it reports.
_SERVER_SEND_METRICS = (
    ("ServerSendPackets", "packets"),
    ("ServerSendGapLatestMs", "latest_gap_ms"),
    ("ServerSendGapMaximumMs", "maximum_gap_ms"),
    ("ServerSendStalls", "stalls"),
    ("ServerSendMonotonicMs", "last_send_monotonic_ms"),
    ("ServerPipelinePosition", "pipeline_position"),
    ("ServerPipelineGeneration", "pipeline_generation"),
    ("ServerPipelinePositionWaitMs", "pipeline_position_wait_ms"),
    ("ServerPipelineMixBuildMs", "pipeline_mix_build_ms"),
    ("ServerPipelineSendtoMs", "pipeline_sendto_ms"),
    ("ServerPipelineIngressGapLatestMs", "pipeline_ingress_gap_latest_ms"),
    ("ServerPipelineIngressGapMaximumMs", "pipeline_ingress_gap_maximum_ms"),
    ("ServerMixCompletePositions", "complete_positions"),
    ("ServerMixPartialPositions", "partial_positions"),
    ("ServerMixMissingContributions", "missing_contributions"),
    ("ServerIngressNonzeroPackets", "ingress_nonzero_packets"),
    ("ServerIngressPeakPcm16", "ingress_peak"),
    ("ServerRecipientNonzeroPackets", "recipient_nonzero_packets"),
    ("ServerRecipientPeakPcm16", "recipient_peak"),
    ("ServerGapClientSendStall", "gap_CLIENT_SEND_STALL"),
    ("ServerGapNetworkOrIngressStall", "gap_NETWORK_OR_INGRESS_STALL"),
    ("ServerGapPositionCollectionStall", "gap_POSITION_COLLECTION_STALL"),
    ("ServerGapMixBuildStall", "gap_MIX_BUILD_STALL"),
    ("ServerGapSendtoStall", "gap_SENDTO_STALL"),
    ("ServerGapEventLoopStall", "gap_SERVER_EVENT_LOOP_STALL"),
    ("ServerGapSeekLifecycleStall", "gap_SEEK_LIFECYCLE_STALL"),
    ("ServerGapUnknown", "gap_UNKNOWN"),
    ("ServerIngressSlackPackets", "ingress_slack_packets"),
    ("ServerIngressSlackNegativePackets", "ingress_slack_negative_packets"),
    ("ServerIngressSlackMinimumMs", "ingress_slack_minimum_ms"),
    ("ServerIngressSlackP5Ms", "ingress_slack_p5_ms"),
    ("ServerIngressSlackP50Ms", "ingress_slack_p50_ms"),
)


class RoomDiagnosticsDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    values: dict[str, str] = Field(max_length=400)


class ProgramLogEntryDto(ApiModel):
    timestamp: str = Field(min_length=1, max_length=64)
    source: str = Field(min_length=1, max_length=64)
    level: str = Field(min_length=1, max_length=16)
    message: str = Field(max_length=4096)


class ProgramLogUploadDto(ApiModel):
    client_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    entries: list[ProgramLogEntryDto] = Field(min_length=1, max_length=100)


async def _bounded_program_log_body(request: Request) -> ProgramLogUploadDto:
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > _MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Program log upload is too large")
        raw.extend(chunk)
    try:
        return ProgramLogUploadDto.model_validate_json(raw)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from error


def add_program_log_route(app: FastAPI, log: ProgramLog) -> None:
    @app.post("/app-logs", status_code=204)
    def upload_program_logs(
        request: Request, body: Annotated[ProgramLogUploadDto, Depends(_bounded_program_log_body)]
    ) -> Response:
        key = request.headers.get(ROOM_KEY_HEADER, "")
        if not 32 <= len(key) <= 256 or not hmac.compare_digest(
            body.client_id, participant_id_for(key)
        ):
            raise HTTPException(status_code=403, detail="Program log identity is invalid")
        peer = request.client.host if request.client else "unknown"
        if not log.append(
            body.client_id,
            [entry.model_dump() for entry in body.entries],
            rate_key=peer,
        ):
            raise HTTPException(status_code=429, detail="Program log upload limit reached")
        return Response(status_code=204)


def add_diagnostics_route(
    app: FastAPI,
    repository: RoomRepository,
    relay: VoiceRelay,
    log: RoomDiagnosticsLog,
    program_log: ProgramLog,
) -> None:
    @app.post("/rooms/{room_id}/diagnostics", status_code=204)
    def room_diagnostics(room_id: str, body: RoomDiagnosticsDto) -> Response:
        """A room member's audio numbers, logged so every computer of a room can be compared."""
        room_id = normalize_room_id(room_id)
        room = room_member(repository, room_id, body.participant_id)
        values = {key[:128]: value[:256] for key, value in body.values.items()}
        server_values = {
            **_server_send_values(relay.recipient_send_metrics(room_id, body.participant_id)),
            **_room_timing_values(room, body.participant_id),
        }
        values.update({key: str(value) for key, value in server_values.items()})
        log.append(room_id, body.participant_id, values)
        program_log.append(
            body.participant_id,
            [
                {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "source": "room-diagnostics",
                    "level": "INFO",
                    "message": dumps(values),
                    "roomId": room_id,
                }
            ],
        )
        return Response(status_code=204)


def _server_send_values(cadence: dict[str, int | float]) -> dict[str, object]:
    """The relay's view of one participant: its send cadence, mix pipeline and deadline slack."""
    return {name: cadence[metric] for name, metric in _SERVER_SEND_METRICS}


def _calibrated(value: float | None) -> object:
    return "calibrating" if value is None else value


def _room_timing_values(room: Room, participant_id: str) -> dict[str, object]:
    """The room timing policy's decision and this participant's part in it."""
    participant = room.participants[participant_id]
    return {
        "TimingRoomDelayMs": room.room_playout_delay_ms,
        "TimingReturnReserveMs": room.room_return_reserve_ms,
        "TimingSource": room.room_timing_source.value,
        "TimingCollectionBudgetMs": ROOM_TIMING.collection_budget_ms,
        "TimingReturnSafetyMarginMs": ROOM_TIMING.return_safety_margin_ms,
        "TimingLiveLimitMs": ROOM_TIMING.eligibility_limit_ms,
        "TimingRouteRequirementMs": participant.voice_latency_ms,
        "TimingReturnRequirementMs": _calibrated(participant.return_requirement_ms),
        "TimingArrivalRequirementMs": _calibrated(participant.arrival_requirement_ms),
        "TimingEligibility": participant.eligibility_reason.value,
    }
