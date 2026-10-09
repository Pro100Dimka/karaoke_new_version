from __future__ import annotations

from dataclasses import dataclass
from math import ceil

import pytest

from backend.room.timing_policy import (
    ROOM_TIMING,
    EligibilityReason,
    TimingSource,
    eligibility,
    select_room_timing,
)
from backend.room.voice_protocol import VOICE_PACKET_MS

LEGACY_FIXED_RETURN_RESERVE_MS = 10.0
MARGIN = ROOM_TIMING.return_safety_margin_ms


def reserve_for(return_ms: float) -> float:
    """The measured return route plus its margin, rounded up to whole packets like the deadline."""
    return ceil((return_ms + MARGIN) / VOICE_PACKET_MS) * VOICE_PACKET_MS


@dataclass(frozen=True)
class Route:
    voice_latency_ms: float
    return_requirement_ms: float | None
    arrival_requirement_ms: float | None
    voice_timing_ready: bool = True


def timing(*routes: Route, song_selected: bool = True):
    return select_room_timing(routes, song_selected=song_selected)


def close_of(selected) -> float:
    return selected.playout_delay_ms - selected.return_reserve_ms


def test_conversation_covers_observed_spike_while_singing_keeps_a_fixed_80_ms_ceiling() -> None:
    spike = Route(173.0, return_requirement_ms=121.5, arrival_requirement_ms=51.5)

    conversation = timing(spike, song_selected=False)
    singing = timing(spike, song_selected=True)

    assert conversation.playout_delay_ms == 250.0
    assert close_of(conversation) >= spike.arrival_requirement_ms
    assert ROOM_TIMING.maximum_room_delay_ms == 80.0
    assert singing.playout_delay_ms <= 80.0


def test_live_limit_rejects_routes_above_80_ms() -> None:
    route = Route(95.0, return_requirement_ms=20.0, arrival_requirement_ms=25.0)

    assert ROOM_TIMING.maximum_room_delay_ms == 80.0
    assert eligibility(route) is EligibilityReason.ROUTE_EXCEEDS_LIVE_LATENCY_LIMIT


def test_idle_conversation_holds_a_250_ms_deadline_as_routes_change() -> None:
    fast = Route(45.0, return_requirement_ms=12.0, arrival_requirement_ms=20.0)
    slower = Route(85.0, return_requirement_ms=25.0, arrival_requirement_ms=30.0)

    assert timing(fast, song_selected=False).playout_delay_ms == 250.0
    assert timing(slower, song_selected=False).playout_delay_ms == 250.0


def test_idle_conversation_reserves_the_observed_return_spike_before_it_happens() -> None:
    ordinary = Route(50.0, return_requirement_ms=20.0, arrival_requirement_ms=30.0)
    observed_spike = Route(102.0, return_requirement_ms=58.5, arrival_requirement_ms=42.5)

    before = timing(ordinary, song_selected=False)
    during = timing(observed_spike, song_selected=False)

    assert before.return_reserve_ms == 60.0
    assert during.return_reserve_ms == 60.0
    assert close_of(before) == close_of(during) == 190.0


def test_a_fast_route_does_not_reserve_the_legacy_ten_milliseconds() -> None:
    selected = timing(Route(12.0, return_requirement_ms=2.0, arrival_requirement_ms=6.0))

    assert selected.return_reserve_ms == reserve_for(2.0)
    assert selected.return_reserve_ms < LEGACY_FIXED_RETURN_RESERVE_MS
    assert selected.playout_delay_ms == 12.5
    assert close_of(selected) >= 6.0  # the legacy close (2.5 ms) was before the voices arrived
    assert selected.source is TimingSource.MEASURED


def test_b_a_slower_acceptable_return_route_gets_what_it_measured() -> None:
    selected = timing(Route(50.0, return_requirement_ms=20.0, arrival_requirement_ms=25.0))

    assert selected.return_reserve_ms == reserve_for(20.0)
    assert selected.playout_delay_ms == 50.0


def test_the_relay_never_closes_before_the_measured_arrival_of_the_voices() -> None:
    # A WAN route with shared-mode output buffering: 15 ms to the relay, 30 ms back to playout.
    selected = timing(Route(45.0, return_requirement_ms=30.0, arrival_requirement_ms=15.0))

    assert close_of(selected) >= 15.0
    assert selected.playout_delay_ms == 47.5  # within a packet of the route, not a stretched room


def test_e_a_route_beyond_the_live_limit_neither_stretches_the_room_nor_its_reserve() -> None:
    good = Route(30.0, return_requirement_ms=4.0, arrival_requirement_ms=20.0)
    bad = Route(240.0, return_requirement_ms=90.0, arrival_requirement_ms=50.0)

    selected = timing(good, bad)

    assert eligibility(bad) is EligibilityReason.ROUTE_EXCEEDS_LIVE_LATENCY_LIMIT
    assert eligibility(good) is EligibilityReason.ELIGIBLE
    assert selected.playout_delay_ms == 30.0
    assert selected.return_reserve_ms == reserve_for(4.0)


def test_f_the_selected_deadline_is_not_an_input_of_the_return_reserve() -> None:
    # The same measured routes give the same reserve whatever the room's previous deadline was:
    # nothing of the deadline flows back into the requirements.
    routes = (Route(30.0, 6.0, 12.0), Route(42.0, 9.0, 20.0))
    first = timing(*routes)
    again = timing(*routes)

    assert first == again
    assert first.return_reserve_ms == reserve_for(9.0)


def test_g_one_deadline_covers_every_listener_route_and_every_singer_arrival() -> None:
    fast = Route(20.0, return_requirement_ms=2.0, arrival_requirement_ms=15.0)
    slow = Route(45.0, return_requirement_ms=15.0, arrival_requirement_ms=25.0)

    selected = timing(fast, slow)

    assert selected.return_reserve_ms == reserve_for(15.0)
    assert selected.playout_delay_ms == 45.0
    assert close_of(selected) >= 25.0


def test_g_a_slow_return_listener_and_a_slow_singer_are_both_covered_by_one_close() -> None:
    # Listener A hears a slow singer B (15 ms to the relay) over a slow return route (15 ms);
    # B hears A, which reaches the relay at once, over a fast return route.
    a = Route(31.0, return_requirement_ms=15.0, arrival_requirement_ms=15.0)
    b = Route(5.0, return_requirement_ms=2.0, arrival_requirement_ms=2.0)

    selected = timing(a, b)

    assert close_of(selected) >= 15.0  # B's voice still makes the close for A
    assert selected.playout_delay_ms == 32.5


def test_idle_conversation_keeps_a_shared_mode_singer_audible_without_stretching_song_timing() -> None:
    fast = Route(65.0, return_requirement_ms=20.0, arrival_requirement_ms=40.0)
    shared_480 = Route(92.5, return_requirement_ms=50.0, arrival_requirement_ms=55.0)

    conversation = timing(fast, shared_480, song_selected=False)
    singing = timing(fast, shared_480, song_selected=True)

    assert conversation.source is TimingSource.IDLE_CONVERSATION
    assert conversation.playout_delay_ms >= 92.5
    assert close_of(conversation) >= 55.0
    assert conversation.playout_delay_ms <= 250.0
    assert singing.playout_delay_ms <= ROOM_TIMING.maximum_room_delay_ms
    assert singing.playout_delay_ms < conversation.playout_delay_ms


def test_idle_conversation_keeps_collection_time_when_all_routes_are_live_eligible() -> None:
    routes = (Route(80.0, 76.5, 27.5), Route(80.0, 72.0, 27.0))

    conversation = timing(*routes, song_selected=False)
    singing = timing(*routes, song_selected=True)

    assert conversation.source is TimingSource.IDLE_CONVERSATION
    assert conversation.playout_delay_ms <= ROOM_TIMING.maximum_idle_delay_ms
    assert close_of(conversation) >= 27.5
    assert singing.source is TimingSource.MEASURED
    assert singing.playout_delay_ms <= ROOM_TIMING.maximum_room_delay_ms


@pytest.mark.parametrize(
    "routes",
    [
        (Route(31.2, None, None), Route(36.1, 5.0, 4.0)),
        (Route(31.2, 3.0, None), Route(36.1, 5.0, 4.0)),
    ],
)
def test_an_uncalibrated_route_keeps_the_previous_deadline_and_says_so(routes) -> None:
    selected = timing(*routes)

    assert selected.source is TimingSource.RETURN_CALIBRATING
    assert selected.return_reserve_ms == ROOM_TIMING.return_requirement.fallback_ms
    assert selected.playout_delay_ms == 37.5  # the deadline before routes were measured


def test_the_deadline_stays_within_the_live_ceiling_and_the_reserve_leaves_collection_time() -> None:
    selected = timing(Route(79.0, 70.0, 20.0), Route(70.0, 2.0, 10.0))

    assert selected.playout_delay_ms <= ROOM_TIMING.maximum_room_delay_ms
    assert selected.return_reserve_ms <= selected.playout_delay_ms - VOICE_PACKET_MS


@pytest.mark.parametrize(
    ("routes", "song_selected", "source"),
    [
        ((), True, TimingSource.NO_PARTICIPANTS),
        ((Route(30, 3, 3, voice_timing_ready=False),), True, TimingSource.AWAITING_ROUTES),
        ((Route(30, 3, 3), Route(120, 3, 3)), False, TimingSource.IDLE_CONVERSATION),
        ((Route(260, 3, 3), Route(260, 3, 3)), True, TimingSource.NO_ELIGIBLE_ROUTE),
    ],
)
def test_the_safe_deadline_names_why_it_was_kept(routes, song_selected, source) -> None:
    selected = select_room_timing(routes, song_selected=song_selected)

    assert selected.source is source
    expected = {
        TimingSource.NO_PARTICIPANTS: ROOM_TIMING.minimum_room_delay_ms,
        TimingSource.AWAITING_ROUTES: ROOM_TIMING.maximum_room_delay_ms,
        TimingSource.IDLE_CONVERSATION: ROOM_TIMING.maximum_idle_delay_ms,
        TimingSource.NO_ELIGIBLE_ROUTE: ROOM_TIMING.maximum_room_delay_ms,
    }[source]
    assert selected.playout_delay_ms == expected
