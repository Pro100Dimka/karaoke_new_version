"""Room members' audio numbers, logged beside the relay's own view so every computer can be compared."""

from __future__ import annotations

from fastapi import FastAPI, Response
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.room_server_access import room_member
from backend.infrastructure.room_diagnostics import RoomDiagnosticsLog
from backend.infrastructure.voice_relay import VoiceRelay
from backend.room.domain import Room
from backend.room.identifiers import normalize_room_id
from backend.room.ports import RoomRepository
from backend.room.timing_policy import ROOM_TIMING

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


def add_diagnostics_route(
    app: FastAPI, repository: RoomRepository, relay: VoiceRelay, log: RoomDiagnosticsLog
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
