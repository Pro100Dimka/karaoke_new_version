"""
Room timing policy: the one contract that decides a room's voice deadline.

A room has one fixed deadline per performance (the room playout delay D): every listener plays the
server's mix of a musical position D after that position. The relay must close each position early
enough that the mix still reaches every listener by D, so it keeps a return reserve R for the route
back and collects singers until D - R.

The deadline is chosen from measurements every participant publishes before a song starts:

- the route requirement: the delay its listener needs for the server's mix to arrive (99th
  percentile of arrival lateness over the last 30 s plus a render guard, measured by AudioService);
- the return requirement: how long the server's mix takes from leaving the relay to this listener's
  playout, including its output buffering (the same 99th percentile, of arrival lateness minus the
  time the mix spent before the relay sent it);
- the arrival requirement: how late the voices this listener hears reach the relay after their
  position (99th percentile of the mix's own report of its latest voice).

Neither of the last two contains anything the relay waited, so a larger deadline cannot make them
larger: the deadline does not feed back into its own requirement.

The voice protocol (sample rate, packet length) and device latency are separate concerns and are
not part of this contract.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from enum import StrEnum
from math import ceil
from typing import Final, Protocol

from backend.room.voice_protocol import VOICE_PACKET_MS, VOICE_PACKETS_PER_SECOND


@dataclass(frozen=True, slots=True)
class ReturnRequirementPolicy:
    # A listener's return requirement is published only after two seconds of returned mix, so the
    # deadline is never chosen from the first few (often unrepresentative) packets.
    calibration_packets: int = 2 * VOICE_PACKETS_PER_SECOND
    # Until then the route keeps the reserve the relay always used before it was measured.
    fallback_ms: float = 10.0


@dataclass(frozen=True, slots=True)
class RoomTimingPolicy:
    # One packet more than the jitter floor every client keeps; a measured route below it still
    # plays at this deadline.
    minimum_room_delay_ms: float = 10.0
    # The product ceiling for live singing together. A route that needs more is not admitted to
    # the live mix; it never stretches the room.
    maximum_room_delay_ms: float = 80.0
    # Conversation without a song can use the full client-supported delay. Singing remains
    # bounded by maximum_room_delay_ms and keeps its selected deadline fixed during the song.
    maximum_idle_delay_ms: float = 160.0
    # After the first singer's packet of a position arrives, the relay waits at most this long for
    # the others before mixing what it has (bounded collection, verified on the Native Relay).
    collection_budget_ms: float = 8.0
    # With no voice arriving at all, the relay still emits each position after this long.
    no_ingress_budget_ms: float = 10.0
    # The relay sends at most one mix per this interval. A forced mix may leave one interval after
    # its close, which is the return reserve's safety margin.
    relay_send_pacing_ms: float = 1.0
    # A coordinated start (song start, sync check) begins this long after the command, so every
    # participant receives it and schedules the same musical moment.
    start_lead_seconds: float = 3.0
    return_requirement: ReturnRequirementPolicy = field(default_factory=ReturnRequirementPolicy)

    @property
    def eligibility_limit_ms(self) -> float:
        return self.maximum_room_delay_ms

    @property
    def return_safety_margin_ms(self) -> float:
        return self.relay_send_pacing_ms


ROOM_TIMING: Final = RoomTimingPolicy()


class EligibilityReason(StrEnum):
    ELIGIBLE = "Eligible"
    TIMING_NOT_MEASURED = "TimingNotMeasured"
    ROUTE_EXCEEDS_LIVE_LATENCY_LIMIT = "RouteExceedsLiveLatencyLimit"


class TimingSource(StrEnum):
    """Why the room has the deadline it has."""

    MEASURED = "Measured"  # every live route, return route and arrival measured
    RETURN_CALIBRATING = "ReturnCalibrating"  # a live route's return/arrival is still calibrating
    AWAITING_ROUTES = "AwaitingRoutes"  # a connected participant has not measured yet
    NO_ELIGIBLE_ROUTE = "NoEligibleRoute"  # every route exceeds the live limit
    IDLE_CONVERSATION = "IdleConversation"  # no song: listeners stay on the safe deadline
    NO_PARTICIPANTS = "NoParticipants"


class TimedRoute(Protocol):
    @property
    def voice_timing_ready(self) -> bool: ...
    @property
    def voice_latency_ms(self) -> float: ...
    @property
    def return_requirement_ms(self) -> float | None: ...
    @property
    def arrival_requirement_ms(self) -> float | None: ...


@dataclass(frozen=True, slots=True)
class RoomTiming:
    playout_delay_ms: float
    return_reserve_ms: float
    source: TimingSource


def eligibility(route: TimedRoute, policy: RoomTimingPolicy = ROOM_TIMING) -> EligibilityReason:
    if not route.voice_timing_ready:
        return EligibilityReason.TIMING_NOT_MEASURED
    if route.voice_latency_ms > policy.eligibility_limit_ms:
        return EligibilityReason.ROUTE_EXCEEDS_LIVE_LATENCY_LIMIT
    return EligibilityReason.ELIGIBLE


def return_requirement(route: TimedRoute, policy: RoomTimingPolicy = ROOM_TIMING) -> float:
    """The reserve this listener needs between the relay's close and its playout."""
    measured = route.return_requirement_ms
    if measured is None:
        return policy.return_requirement.fallback_ms
    # A return route can never need more than the whole route it is part of.
    return min(measured, route.voice_latency_ms) + policy.return_safety_margin_ms


def select_room_timing(
    connected: Iterable[TimedRoute],
    *,
    song_selected: bool,
    policy: RoomTimingPolicy = ROOM_TIMING,
) -> RoomTiming:
    """
    One deadline for the room and the relay's return reserve.

    The deadline covers the slowest live listener's whole route, and also the latest measured
    arrival of a voice at the relay plus the slowest live listener's return route, because the
    relay closes every position once for all listeners. Routes beyond the live limit are left out: they get an
    eligibility reason instead of raising the room. The result is packet aligned and bounded by the
    policy's minimum and maximum.
    """
    routes = list(connected)
    fallback = policy.return_requirement.fallback_ms
    if not routes:
        return RoomTiming(policy.minimum_room_delay_ms, fallback, TimingSource.NO_PARTICIPANTS)
    if any(not route.voice_timing_ready for route in routes):
        ceiling = policy.maximum_room_delay_ms if song_selected else policy.maximum_idle_delay_ms
        return RoomTiming(ceiling, fallback, TimingSource.AWAITING_ROUTES)
    if not song_selected:
        return _idle_timing(routes, policy)
    live = [route for route in routes if eligibility(route, policy) is EligibilityReason.ELIGIBLE]
    if not live:
        # Falling back to the minimum here would make every packet late, so no route could ever
        # recover; keep the safest bounded deadline instead.
        return RoomTiming(policy.maximum_room_delay_ms, fallback, TimingSource.NO_ELIGIBLE_ROUTE)
    whole_route = max(route.voice_latency_ms for route in live)
    if not _returns_measured(live):
        # A return route still calibrating: the deadline and reserve the room used before return
        # routes were measured, rather than a mix of measured and assumed routes.
        return RoomTiming(_packet_aligned(whole_route, policy), fallback, TimingSource.RETURN_CALIBRATING)
    return _measured_timing(live, whole_route, policy)


def _returns_measured(routes: list[TimedRoute]) -> bool:
    return all(
        route.return_requirement_ms is not None and route.arrival_requirement_ms is not None
        for route in routes
    )


def _idle_timing(routes: list[TimedRoute], policy: RoomTimingPolicy) -> RoomTiming:
    """No musical deadline is active: cover every measured listener and singer within the delay
    range the clients already support, including routes above the singing limit."""
    idle_policy = replace(policy, maximum_room_delay_ms=policy.maximum_idle_delay_ms)
    whole_route = max(route.voice_latency_ms for route in routes)
    if not _returns_measured(routes):
        return RoomTiming(
            _packet_aligned(whole_route, idle_policy),
            policy.return_requirement.fallback_ms,
            TimingSource.IDLE_CONVERSATION,
        )
    measured = _measured_timing(routes, whole_route, idle_policy)
    return RoomTiming(
        measured.playout_delay_ms, measured.return_reserve_ms, TimingSource.IDLE_CONVERSATION
    )


def _measured_timing(
    live: list[TimedRoute], whole_route: float, policy: RoomTimingPolicy
) -> RoomTiming:
    # Packet aligned like the deadline: a return route that wanders by a fraction of a packet must
    # not move the relay's close (each move restarts the relay's room timeline).
    reserve = _whole_packets(max(return_requirement(route, policy) for route in live))
    arrival = max(route.arrival_requirement_ms or 0.0 for route in live)
    delay = _packet_aligned(max(whole_route, arrival + reserve), policy)
    # The relay always keeps at least one packet of collection before the close.
    reserve = max(0.0, min(reserve, delay - VOICE_PACKET_MS))
    return RoomTiming(delay, reserve, TimingSource.MEASURED)


def _packet_aligned(required_ms: float, policy: RoomTimingPolicy) -> float:
    return _whole_packets(
        max(policy.minimum_room_delay_ms, min(policy.maximum_room_delay_ms, required_ms))
    )


def _whole_packets(milliseconds: float) -> float:
    return ceil(round(milliseconds / VOICE_PACKET_MS, 9)) * VOICE_PACKET_MS
