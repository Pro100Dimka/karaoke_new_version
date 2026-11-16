from backend.api.base_dto import ApiModel
from backend.room.domain import Participant
from pydantic import Field


class RoomParticipantDto(ApiModel):
    participant_id: str
    display_name: str
    role: str
    connection_state: str
    readiness_state: str
    transfer_progress: int = Field(ge=0, le=100)
    voice_latency_ms: float = Field(ge=0, le=500)
    voice_timing_ready: bool
    voice_eligible: bool
    eligibility_reason: str
    return_requirement_ms: float | None = None
    arrival_requirement_ms: float | None = None
    performance_accuracy: float | None = None

    performance_sung_seconds: float = 0
    voice_settings: dict[str, float] | None = None
    voice_settings_revision: int = 0


def room_participant(item: Participant) -> RoomParticipantDto:
    return RoomParticipantDto(
        participant_id=item.participant_id,
        display_name=item.display_name,
        role=item.role.value,
        connection_state=item.connection_state.value,
        readiness_state=item.readiness_state.value,
        transfer_progress=item.transfer_progress,
        voice_latency_ms=item.voice_latency_ms,
        voice_timing_ready=item.voice_timing_ready,
        voice_eligible=item.voice_eligible,
        eligibility_reason=item.eligibility_reason.value,
        return_requirement_ms=item.return_requirement_ms,
        arrival_requirement_ms=item.arrival_requirement_ms,
        performance_accuracy=item.performance_accuracy,
        performance_sung_seconds=item.performance_sung_seconds,
        voice_settings=item.voice_settings,
        voice_settings_revision=item.voice_settings_revision,
    )
