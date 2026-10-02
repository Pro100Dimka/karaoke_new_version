from __future__ import annotations

import socket
import struct
import time

from backend.infrastructure.voice_relay import (
    RelaySocket,
    VoiceRelay,
    _PendingPcm,
    _RETURN_ROUTE_RESERVE_SECONDS,
    participant_key,
)


def test_pending_pcm_reports_exact_frame_coverage_and_missing_ranges() -> None:
    pending = _PendingPcm.empty(8, 0)
    pending.write(2, (10, 20, 30))
    assert pending.coverage() == {
        "expected_frames": 8,
        "present_frames": 3,
        "missing_frames": 5,
        "missing_ranges": [[0, 1], [5, 7]],
    }

_MAGIC = 0x32445541
_SHARED_TIMELINE = 1 << 63
_SERVER_MIX_ID = "__room_server_mix__"


def _packet(
    sender_id: str,
    token: int,
    sequence: int = 1,
    *,
    version: int = 1,
    header_bytes: int = 36,
) -> bytes:
    # Mirrors the fixed little-endian AudioService wire header through the authenticated session token.
    header = struct.pack(
        "<IHHIIQ",
        _MAGIC,
        version,
        header_bytes,
        sequence,
        participant_key(sender_id),
        token,
    )
    header += b"\x00" * (header_bytes - len(header))
    return header + b"payload"


def _pcm_packet(
    sender_id: str,
    token: int,
    timestamp_frame: int,
    samples: tuple[int, ...],
    sequence: int = 1,
) -> bytes:
    header = struct.pack(
        "<IHHIIQQBBHII",
        _MAGIC,
        3,
        44,
        sequence,
        participant_key(sender_id),
        token,
        timestamp_frame | _SHARED_TIMELINE,
        1,
        1,  # PCM16
        len(samples),
        0,
        1,
    )
    return header + struct.pack(f"<{len(samples)}h", *samples)


def _pcm_samples(packet: bytes) -> tuple[int, ...]:
    frames = struct.unpack_from("<H", packet, 34)[0]
    return struct.unpack_from(f"<{frames}h", packet, 44)


class _FakeTransport:
    def __init__(self) -> None:
        self.sent: list[tuple[bytes, tuple[str, int]]] = []

    def sendto(self, data: bytes, address: tuple[str, int]) -> None:
        self.sent.append((data, address))


def _relay(clock: list[float]) -> tuple[VoiceRelay, _FakeTransport]:
    relay = VoiceRelay(now=lambda: clock[0], wall_now=lambda: clock[0], mix_packet_copies=1)
    transport = _FakeTransport()
    relay.connection_made(transport)
    return relay, transport


def test_server_mix_sends_redundant_identical_datagrams_for_loss_tolerance() -> None:
    relay = VoiceRelay(now=lambda: 0.0)
    transport = _FakeTransport()
    relay.connection_made(transport)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}

    for participant, value in (("alice", 100), ("bob", 1_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (value,) * 120),
            addresses[participant],
        )

    for address in addresses.values():
        copies = [packet for packet, target in transport.sent if target == address]
        assert len(copies) == 2
        assert copies[0] == copies[1]


def test_unmeasured_singer_never_holds_back_the_live_mix_for_the_room() -> None:
    relay, transport = _relay([0.0])
    participants = ("alice", "bob", "slow")
    tokens = {participant: relay.expect("room-1", participant) for participant in participants}
    addresses = {
        participant: ("10.0.0.1", 41001 + index)
        for index, participant in enumerate(participants)
    }
    for participant in participants:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 47_880, (0,) * 120),
            addresses[participant],
        )
    transport.sent.clear()
    relay.set_room_eligible_participants("room-1", {"alice", "bob"})

    for participant, value in (("alice", 100), ("bob", 1_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (value,) * 120),
            addresses[participant],
        )

    assert len(transport.sent) == 3
    packets_by_address = {address: packet for packet, address in transport.sent}
    assert _pcm_samples(packets_by_address[addresses["alice"]]) == (1_000,) * 120
    assert _pcm_samples(packets_by_address[addresses["bob"]]) == (100,) * 120
    assert _pcm_samples(packets_by_address[addresses["slow"]]) == (1_100,) * 120


def test_server_mix_reports_ingress_and_collection_time_for_the_returned_voices() -> None:
    monotonic = [10.0]
    wall = [1_000.050]
    relay = VoiceRelay(
        now=lambda: monotonic[0], wall_now=lambda: wall[0], mix_packet_copies=1
    )
    transport = _FakeTransport()
    relay.connection_made(transport)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    timestamp = 1_000 * 48_000

    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], timestamp, (100,) * 120), addresses["alice"]
    )
    monotonic[0] += 0.004
    wall[0] += 0.004
    relay.datagram_received(
        _pcm_packet("bob", tokens["bob"], timestamp, (1_000,) * 120), addresses["bob"]
    )

    packets = {address: packet for packet, address in transport.sent}
    alice_report = struct.unpack_from("<I", packets[addresses["alice"]], 36)[0]
    bob_report = struct.unpack_from("<I", packets[addresses["bob"]], 36)[0]
    assert alice_report & 0xFFFF == 2_592  # Bob: capture position -> Oracle arrival.
    assert bob_report & 0xFFFF == 2_400  # Alice: capture position -> Oracle arrival.
    assert alice_report >> 16 == bob_report >> 16 == 192  # Four milliseconds collecting the mix.


def test_server_mix_metrics_expose_nonzero_audio_at_each_relay_stage() -> None:
    relay, transport = _relay([0.0])
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    for participant, value in (("alice", 100), ("bob", 1_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (value,) * 120),
            addresses[participant],
        )
    metrics = relay.mix_metrics("room-1")
    assert metrics["ingress_packets"] == 2
    assert metrics["ingress_nonzero_packets"] == 2
    assert metrics["nonzero_inputs"] == 2
    lifecycle = metrics["position_lifecycle"]
    assert any(
        item["participant"] == "alice"
        and item["insert_attempted"] is True
        and item["inserted"] is True
        and item["participant_expected"] is True
        for item in lifecycle
    )
    assert metrics["overlap_histogram"]["120"] >= 2
    assert all("overlap_start" in item and "overlap_end" in item for item in lifecycle)
    assert metrics["complete_positions"] == 1
    assert metrics["partial_positions"] == 0
    assert metrics["max_inputs_seen"] == 2
    assert metrics["excluded_mixers"] == 0
    assert metrics["position_trace"][0]["complete"] is True
    assert metrics["position_trace"][0]["expected"] == ["alice", "bob"]
    assert metrics["exclusion_trace"] == []
    assert metrics["collection_slack_samples"][0]["participant"] in {"alice", "bob"}
    assert metrics["logical_recipient_packets"] == 2
    assert metrics["logical_nonzero_recipient_packets"] == 2
    assert metrics["energy_trace"]["ingress"]["packets"] == 2
    assert metrics["energy_trace"]["ingress"]["nonzero_packets"] == 2
    assert metrics["energy_trace"]["ingress"]["nonzero_samples"] == 240
    assert metrics["energy_trace"]["ingress"]["rms_nonzero"] > 0
    assert metrics["energy_trace"]["mix_inputs"]["peak"] > 0
    assert metrics["energy_trace"]["recipient_mix"]["nonzero_packets"] == 2
    assert metrics["participant_trace"]["alice"]["ingress_packets"] == 1
    assert metrics["participant_trace"]["alice"]["assigned_positions"] == 1
    assert metrics["participant_trace"]["alice"]["mixed_positions"] == 1
    assert metrics["participant_trace"]["alice"]["recipient_nonzero_packets"] == 1
    lifecycle = metrics["pending_lifecycle"]
    assert lifecycle["created_positions"] == 1
    assert lifecycle["complete_nonempty_positions"] == 1
    assert lifecycle["mixed_positions"] == 1
    assert lifecycle["pending_at_end"] == 0


def test_server_mix_metrics_expose_each_participants_live_microphone_level() -> None:
    clock = [0.0]
    relay, _transport = _relay(clock)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}

    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 48_000, (16_384,) * 120), addresses["alice"]
    )
    relay.datagram_received(
        _pcm_packet("bob", tokens["bob"], 48_000, (8_192,) * 120), addresses["bob"]
    )

    assert relay.mix_metrics("room-1")["participant_levels"] == {
        "alice": 0.5,
        "bob": 0.25,
    }

    clock[0] += 0.5
    assert relay.mix_metrics("room-1")["participant_levels"] == {
        "alice": 0.0,
        "bob": 0.0,
    }


def test_metrics_report_same_timestamp_with_different_packet_frames() -> None:
    relay, _transport = _relay([0.0])
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 48_000, (100,) * 120), addresses["alice"]
    )
    relay.datagram_received(
        _pcm_packet("bob", tokens["bob"], 48_000, (1_000,) * 240), addresses["bob"]
    )
    metrics = relay.mix_metrics("room-1")
    assert metrics["same_timestamp_different_frames"] == 1
    assert metrics["same_timestamp_different_frames_examples"]["48000"] == [120, 240]


def test_two_singer_mix_minus_preserves_the_other_singer_samples() -> None:
    relay, transport = _relay([0.0])
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    samples = {"alice": (100, -200, 300, -400), "bob": (1_000, -900, 800, -700)}
    for participant in ("alice", "bob"):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, samples[participant]),
            addresses[participant],
        )
    packets = {address: packet for packet, address in transport.sent}
    payload = lambda address: struct.unpack_from("<4h", packets[address], 44)
    assert payload(addresses["alice"]) == samples["bob"]
    assert payload(addresses["bob"]) == samples["alice"]


def test_new_performance_reuses_musical_positions_in_a_new_server_mix_epoch() -> None:
    relay, transport = _relay([0.0])
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}

    for timestamp, sequence in ((0, 1), (60_000, 2)):
        for participant, value in (("alice", 100), ("bob", 1_000)):
            relay.datagram_received(
                _pcm_packet(participant, tokens[participant], timestamp, (value, value), sequence),
                addresses[participant],
            )
    previous_epoch = struct.unpack_from("<I", transport.sent[-1][0], 40)[0]
    transport.sent.clear()

    for participant, value in (("alice", 200), ("bob", 2_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 0, (value, value), 3),
            addresses[participant],
        )

    assert len(transport.sent) == 2
    assert struct.unpack_from("<I", transport.sent[-1][0], 40)[0] != previous_epoch


def test_a_packet_is_forwarded_to_the_other_expected_room_member_but_not_the_sender() -> None:
    relay, transport = _relay([0.0])
    host_token = relay.expect("room-1", "host")
    guest_token = relay.expect("room-1", "guest")
    relay.datagram_received(_packet("guest", guest_token), ("203.0.113.5", 5555))

    relay.datagram_received(_packet("host", host_token), ("198.51.100.9", 4444))

    assert transport.sent == [(_packet("host", guest_token), ("203.0.113.5", 5555))]


def test_current_audio_service_v3_packet_is_forwarded() -> None:
    relay, transport = _relay([0.0])
    host_token = relay.expect("room-1", "host")
    guest_token = relay.expect("room-1", "guest")
    guest_packet = _packet("guest", guest_token, version=3, header_bytes=44)
    host_packet = _packet("host", host_token, version=3, header_bytes=44)
    relay.datagram_received(guest_packet, ("203.0.113.5", 5555))

    relay.datagram_received(host_packet, ("198.51.100.9", 4444))

    assert transport.sent == [
        (_packet("host", guest_token, version=3, header_bytes=44), ("203.0.113.5", 5555))
    ]


def test_room_server_sends_each_singer_one_timestamped_mix_of_everyone_else() -> None:
    relay, transport = _relay([0.0])
    tokens = {
        participant: relay.expect("room-1", participant)
        for participant in ("alice", "bob", "carol")
    }
    addresses = {
        "alice": ("10.0.0.1", 41001),
        "bob": ("10.0.0.2", 41002),
        "carol": ("10.0.0.3", 41003),
    }
    # A first complete musical position teaches the UDP endpoint for every authenticated singer.
    for participant in ("alice", "bob", "carol"):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 47_880, (0, 0), 1),
            addresses[participant],
        )
    transport.sent.clear()

    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 48_000, (100, 200), 2), addresses["alice"]
    )
    relay.datagram_received(
        _pcm_packet("bob", tokens["bob"], 48_000, (1_000, 2_000), 2), addresses["bob"]
    )
    relay.datagram_received(
        _pcm_packet("carol", tokens["carol"], 48_000, (10_000, 20_000), 2), addresses["carol"]
    )

    assert len(transport.sent) == 3
    packets_by_address = {address: packet for packet, address in transport.sent}
    assert _pcm_samples(packets_by_address[addresses["alice"]]) == (11_000, 22_000)
    assert _pcm_samples(packets_by_address[addresses["bob"]]) == (10_100, 20_200)
    assert _pcm_samples(packets_by_address[addresses["carol"]]) == (1_100, 2_200)
    for participant, address in addresses.items():
        packet = packets_by_address[address]
        assert struct.unpack_from("<I", packet, 12)[0] == participant_key(_SERVER_MIX_ID)
        assert struct.unpack_from("<Q", packet, 16)[0] == tokens[participant]
        assert struct.unpack_from("<Q", packet, 24)[0] == 48_000 | _SHARED_TIMELINE


def test_a_missing_singer_cannot_delay_the_room_and_their_late_packet_is_never_replayed() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    tokens = {
        participant: relay.expect("room-1", participant)
        for participant in ("alice", "bob", "unstable")
    }
    addresses = {
        "alice": ("10.0.0.1", 41001),
        "bob": ("10.0.0.2", 41002),
        "unstable": ("10.0.0.3", 41003),
    }
    for participant in addresses:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 47_880, (0, 0), 1),
            addresses[participant],
        )
    transport.sent.clear()

    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 48_000, (100, 200), 2), addresses["alice"]
    )
    relay.datagram_received(
        _pcm_packet("bob", tokens["bob"], 48_000, (1_000, 2_000), 2), addresses["bob"]
    )
    assert transport.sent == []
    clock[0] = 0.008
    relay.flush_due()

    assert len(transport.sent) == 3
    packets_by_address = {address: packet for packet, address in transport.sent}
    assert _pcm_samples(packets_by_address[addresses["alice"]]) == (1_000, 2_000)
    assert _pcm_samples(packets_by_address[addresses["bob"]]) == (100, 200)
    assert _pcm_samples(packets_by_address[addresses["unstable"]]) == (1_100, 2_200)

    relay.datagram_received(
        _pcm_packet("unstable", tokens["unstable"], 48_000, (10_000, 20_000), 2),
        addresses["unstable"],
    )
    assert len(transport.sent) == 3


def test_one_missed_position_does_not_mute_the_singer_for_the_recovery_window() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    tokens = {
        participant: relay.expect("room-1", participant)
        for participant in ("alice", "bob", "intermittent")
    }
    addresses = {
        "alice": ("10.0.0.1", 41001),
        "bob": ("10.0.0.2", 41002),
        "intermittent": ("10.0.0.3", 41003),
    }
    for participant in addresses:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 47_880, (0,) * 120, 1),
            addresses[participant],
        )
    transport.sent.clear()

    # This exact musical position may not wait for a late singer and must never be replayed.
    for participant, value in (("alice", 100), ("bob", 1_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (value,) * 120, 2),
            addresses[participant],
        )
    clock[0] = 0.008
    relay.flush_due()
    relay.datagram_received(
        _pcm_packet("intermittent", tokens["intermittent"], 48_000, (10_000,) * 120, 2),
        addresses["intermittent"],
    )
    assert len(transport.sent) == 3

    # One isolated 2.5 ms miss is not an unstable stream. Its next on-time current position
    # must be audible instead of disappearing for the entire 0.5 s recovery window.
    transport.sent.clear()
    for participant, value in (("intermittent", 10_000), ("alice", 100), ("bob", 1_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_120, (value,) * 120, 3),
            addresses[participant],
        )

    packets_by_address = {address: packet for packet, address in transport.sent}
    assert _pcm_samples(packets_by_address[addresses["alice"]]) == (11_000,) * 120


def test_room_deadline_accepts_differently_phased_devices_before_the_same_musical_position() -> None:
    clock = [1.030]
    relay, transport = _relay(clock)
    relay.set_room_playout_delay("room-1", 80.0)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("asio", "shared")}
    addresses = {"asio": ("10.0.0.1", 41001), "shared": ("10.0.0.2", 41002)}

    relay.datagram_received(
        _pcm_packet("asio", tokens["asio"], 48_000, (100, 200), 1), addresses["asio"]
    )
    clock[0] = 1.050  # 20 ms later, but still before 1.060: 80 ms deadline - 20 ms return reserve.
    relay.datagram_received(
        _pcm_packet("shared", tokens["shared"], 48_000, (1_000, 2_000), 1),
        addresses["shared"],
    )

    assert len(transport.sent) == 2
    packets_by_address = {address: packet for packet, address in transport.sent}
    assert _pcm_samples(packets_by_address[addresses["asio"]]) == (1_000, 2_000)
    assert _pcm_samples(packets_by_address[addresses["shared"]]) == (100, 200)


def test_thirty_five_ms_deadline_keeps_a_fourteen_ms_ingress_pair_in_the_same_mix() -> None:
    assert _RETURN_ROUTE_RESERVE_SECONDS <= 0.010
    clock = [1.000]
    relay, transport = _relay(clock)
    relay.set_room_playout_delay("room-1", 35.0)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    relay.datagram_received(_pcm_packet("alice", tokens["alice"], 48_000, (100,) * 120, 1), addresses["alice"])
    clock[0] = 1.016
    relay.datagram_received(_pcm_packet("bob", tokens["bob"], 48_000, (1_000,) * 120, 1), addresses["bob"])
    assert len(transport.sent) == 2


def test_packet_received_before_close_is_not_lost_when_processing_runs_after_close() -> None:
    clock = [1.030]
    relay, transport = _relay(clock)
    relay.set_room_playout_delay("room-1", 80.0)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 48_000, (100,) * 120),
        addresses["alice"],
        arrival_now=1.030,
    )
    clock[0] = 1.075  # relay callback is scheduled after the fixed 1.070 close.
    relay.datagram_received(
        _pcm_packet("bob", tokens["bob"], 48_000, (1_000,) * 120),
        addresses["bob"],
        arrival_now=1.050,  # the datagram was already received before close.
    )

    assert len(transport.sent) == 2


def test_fixed_room_deadline_expires_on_the_monotonic_clock_when_a_singer_is_missing() -> None:
    monotonic = [10.0]
    wall = [1_000.030]
    relay = VoiceRelay(
        now=lambda: monotonic[0], wall_now=lambda: wall[0], mix_packet_copies=1
    )
    transport = _FakeTransport()
    relay.connection_made(transport)
    relay.set_room_playout_delay("room-1", 80.0)
    tokens = {
        participant: relay.expect("room-1", participant)
        for participant in ("alice", "missing")
    }
    addresses = {"alice": ("10.0.0.1", 41001), "missing": ("10.0.0.2", 41002)}
    # Teach the relay both return addresses with one complete earlier position.
    for participant in addresses:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 999 * 48_000, (0,) * 120),
            addresses[participant],
        )
    transport.sent.clear()

    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 1_000 * 48_000, (100,) * 120),
        addresses["alice"],
    )
    monotonic[0] += 0.071
    wall[0] += 0.071
    relay.flush_due()

    assert len(transport.sent) == 2


def test_waiting_for_first_voice_packet_does_not_exclude_a_starting_singer() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    for sequence in range(3):
        timestamp = 48_000 + sequence * 120
        relay.datagram_received(
            _pcm_packet("alice", tokens["alice"], timestamp, (100,) * 120, sequence + 1),
            addresses["alice"],
        )
        clock[0] += 0.008
        relay.flush_due()
    assert relay.mix_metrics("room-1")["excluded_mixers"] == 0


def test_exclusion_trace_keeps_the_first_active_misses_and_their_transport_cause() -> None:
    clock = [0.0]
    relay, _transport = _relay(clock)
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    for participant in ("alice", "bob"):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (100,) * 120),
            addresses[participant],
        )
    for sequence in range(1, 4):
        relay.datagram_received(
            _pcm_packet("alice", tokens["alice"], 48_000 + sequence * 120, (100,) * 120, sequence + 1),
            addresses["alice"],
        )
        clock[0] += 0.008
        relay.flush_due()

    # A short burst alone is degraded state; only sustained absence may exclude the singer.
    clock[0] += 0.5
    relay.datagram_received(
        _pcm_packet("alice", tokens["alice"], 48_480, (100,) * 120, 5), addresses["alice"]
    )
    clock[0] += 0.008
    relay.flush_due()

    exclusion = relay.mix_metrics("room-1")["exclusion_trace"][0]
    assert [item["consecutive_misses"] for item in exclusion["miss_history"]] == [1, 2, 3, 4]
    assert {item["classification"] for item in exclusion["miss_history"]} == {"NO_INGRESS"}
    assert all(item["late_by_ms"] is None for item in exclusion["miss_history"])


def test_pcm_mix_keeps_every_position_across_44100_to_48000_timestamp_rounding() -> None:
    relay, transport = _relay([0.0])
    tokens = {participant: relay.expect("room-1", participant) for participant in ("alice", "bob")}
    addresses = {"alice": ("10.0.0.1", 41001), "bob": ("10.0.0.2", 41002)}
    # 110/110/110/111 device frames become 120 PCM frames each. Scaling their starts to 48 kHz
    # produces 119/120/120/121-frame steps, including a harmless one-sample rounding hole.
    timestamps = (48_000, 48_119, 48_239, 48_359, 48_480)

    for sequence, timestamp in enumerate(timestamps, 1):
        for participant, value in (("alice", 100), ("bob", 1_000)):
            relay.datagram_received(
                _pcm_packet(participant, tokens[participant], timestamp, (value,) * 120, sequence),
                addresses[participant],
            )

    packets_by_address = {
        address: [packet for packet, target in transport.sent if target == address]
        for address in addresses.values()
    }
    assert len(packets_by_address[addresses["alice"]]) == len(timestamps)
    assert len(packets_by_address[addresses["bob"]]) == len(timestamps)
    assert all(
        _pcm_samples(packet) == (1_000,) * 120
        for packet in packets_by_address[addresses["alice"]]
    )


def test_an_excluded_singer_rejoins_only_at_the_current_position_after_a_stable_window() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    tokens = {
        participant: relay.expect("room-1", participant)
        for participant in ("alice", "bob", "recovering")
    }
    addresses = {
        "alice": ("10.0.0.1", 41001),
        "bob": ("10.0.0.2", 41002),
        "recovering": ("10.0.0.3", 41003),
    }
    for participant in addresses:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 47_880, (0, 0), 1),
            addresses[participant],
        )
    # Three consecutive missed deadlines identify an unstable route and exclude it.
    for sequence in range(2, 5):
        timestamp = 48_000 + (sequence - 2) * 2
        relay.datagram_received(
            _pcm_packet("alice", tokens["alice"], timestamp, (100, 200), sequence),
            addresses["alice"],
        )
        relay.datagram_received(
            _pcm_packet("bob", tokens["bob"], timestamp, (1_000, 2_000), sequence),
            addresses["bob"],
        )
        clock[0] += 0.008
        relay.flush_due()

    for sequence in range(5, 205):
        transport.sent.clear()
        timestamp = 48_000 + (sequence - 2) * 2
        # The recovering stream arrives first for 0.5 s continuously; it must remain inaudible
        # until that window is complete, then join this current position rather than an old one.
        relay.datagram_received(
            _pcm_packet("recovering", tokens["recovering"], timestamp, (10_000, 20_000), sequence),
            addresses["recovering"],
        )
        relay.datagram_received(
            _pcm_packet("recovering", tokens["recovering"], timestamp, (10_000, 20_000), sequence),
            addresses["recovering"],
        )
        relay.datagram_received(
            _pcm_packet("alice", tokens["alice"], timestamp, (100, 200), sequence),
            addresses["alice"],
        )
        relay.datagram_received(
            _pcm_packet("bob", tokens["bob"], timestamp, (1_000, 2_000), sequence),
            addresses["bob"],
        )
        packets_by_address = {address: packet for packet, address in transport.sent}
        expected = (11_000, 22_000)
        assert _pcm_samples(packets_by_address[addresses["alice"]]) == expected


def test_consecutive_late_packets_do_not_rejoin_an_excluded_singer() -> None:
    clock = [1.0]
    relay, transport = _relay(clock)
    relay.set_room_playout_delay("room-1", 60)
    participants = ("alice", "bob", "late")
    tokens = {participant: relay.expect("room-1", participant) for participant in participants}
    addresses = {
        participant: ("10.0.0.1", 41001 + index)
        for index, participant in enumerate(participants)
    }
    for participant in participants:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (0,) * 120, 1),
            addresses[participant],
        )

    for sequence in range(2, 5):
        timestamp = 48_000 + (sequence - 1) * 120
        clock[0] = timestamp / 48_000
        for participant, value in (("alice", 100), ("bob", 1_000)):
            relay.datagram_received(
                _pcm_packet(participant, tokens[participant], timestamp, (value,) * 120, sequence),
                addresses[participant],
            )
        clock[0] = timestamp / 48_000 + 0.061
        relay.flush_due()

    for sequence in range(5, 205):
        timestamp = 48_000 + (sequence - 1) * 120
        clock[0] = timestamp / 48_000 + 0.010
        for participant, value in (("alice", 100), ("bob", 1_000)):
            relay.datagram_received(
                _pcm_packet(participant, tokens[participant], timestamp, (value,) * 120, sequence),
                addresses[participant],
            )
        clock[0] = timestamp / 48_000 + 0.070
        relay.datagram_received(
            _pcm_packet("late", tokens["late"], timestamp, (10_000,) * 120, sequence),
            addresses["late"],
        )

    timestamp = 48_000 + 204 * 120
    clock[0] = timestamp / 48_000 + 0.010
    transport.sent.clear()
    for participant, value in (("late", 10_000), ("alice", 100), ("bob", 1_000)):
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], timestamp, (value,) * 120, 205),
            addresses[participant],
        )
    packets_by_address = {address: packet for packet, address in transport.sent}
    assert _pcm_samples(packets_by_address[addresses["alice"]]) == (1_000,) * 120


def test_server_mix_supports_four_simultaneous_singers_without_self_echo() -> None:
    relay, transport = _relay([0.0])
    participants = ("a", "b", "c", "d")
    tokens = {participant: relay.expect("room-1", participant) for participant in participants}
    addresses = {
        participant: ("10.0.0.1", 42000 + index) for index, participant in enumerate(participants)
    }
    values = {"a": 1, "b": 10, "c": 100, "d": 1_000}

    for participant in participants:
        relay.datagram_received(
            _pcm_packet(participant, tokens[participant], 48_000, (values[participant],), 1),
            addresses[participant],
        )

    packets_by_address = {address: packet for packet, address in transport.sent}
    total = sum(values.values())
    assert len(packets_by_address) == 4
    for participant in participants:
        assert _pcm_samples(packets_by_address[addresses[participant]]) == (
            total - values[participant],
        )


def test_server_aligns_different_capture_callback_phases_to_one_packet_position() -> None:
    relay, transport = _relay([0.0])
    participants = ("alice", "bob", "carol")
    tokens = {participant: relay.expect("room-1", participant) for participant in participants}
    addresses = {
        participant: ("10.0.0.1", 43000 + index) for index, participant in enumerate(participants)
    }
    # The continuous streams cover the same music but their device callbacks begin one frame
    # apart. The server must re-block their samples instead of playing the packets serially.
    for participant, timestamp, value in (
        ("alice", 48_000, 100),
        ("bob", 48_001, 1_000),
        ("carol", 47_999, 10_000),
    ):
        for sequence in range(1, 4):
            relay.datagram_received(
                _pcm_packet(
                    participant,
                    tokens[participant],
                    timestamp + (sequence - 1) * 4,
                    (value,) * 4,
                    sequence,
                ),
                addresses[participant],
            )

    assert len(transport.sent) >= 3
    assert {struct.unpack_from("<Q", packet, 24)[0] for packet, _address in transport.sent} >= {
        48_004 | _SHARED_TIMELINE
    }


def test_server_aligns_sub_two_millisecond_phases_across_a_packet_boundary() -> None:
    relay, transport = _relay([0.0])
    participants = ("alice", "bob", "carol")
    tokens = {participant: relay.expect("room-1", participant) for participant in participants}
    addresses = {
        participant: ("10.0.0.1", 44000 + index) for index, participant in enumerate(participants)
    }
    samples = (100,) * 120
    # Alice and Bob differ by 95 transport frames (1.98 ms), but ordinary nearest-packet
    # rounding puts them on opposite sides of a 120-frame boundary.
    for participant, timestamp in (("alice", 48_060), ("bob", 47_965), ("carol", 48_059)):
        for sequence in range(1, 4):
            relay.datagram_received(
                _pcm_packet(
                    participant,
                    tokens[participant],
                    timestamp + (sequence - 1) * 120,
                    samples,
                    sequence,
                ),
                addresses[participant],
            )

    assert len(transport.sent) >= 3
    assert any(
        struct.unpack_from("<Q", packet, 24)[0] == 48_120 | _SHARED_TIMELINE
        for packet, _address in transport.sent
    )


def test_forwarded_packet_is_reauthenticated_for_the_recipient() -> None:
    relay, transport = _relay([0.0])
    host_token = relay.expect("room-1", "host")
    guest_token = relay.expect("room-1", "guest")
    relay.datagram_received(_packet("guest", guest_token), ("203.0.113.5", 5555))

    relay.datagram_received(_packet("host", host_token), ("198.51.100.9", 4444))

    assert transport.sent == [(_packet("host", guest_token), ("203.0.113.5", 5555))]


def test_relay_echoes_one_authenticated_probe_per_second_to_measure_rtt() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    host_token = relay.expect("room-1", "host")
    address = ("198.51.100.9", 4444)

    relay.datagram_received(_packet("host", host_token, 1), address)
    clock[0] = 0.5
    relay.datagram_received(_packet("host", host_token, 2), address)
    clock[0] = 1.0
    relay.datagram_received(_packet("host", host_token, 3), address)

    assert transport.sent == [(_packet("host", host_token, 3), address)]


def test_central_pcm_mix_keeps_the_authenticated_rtt_probe() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    token = relay.expect("room-1", "singer")
    address = ("198.51.100.9", 4444)
    relay.datagram_received(_pcm_packet("singer", token, 48_000, (100, 200), 1), address)
    transport.sent.clear()

    clock[0] = 1.0
    packet = _pcm_packet("singer", token, 48_002, (300, 400), 2)
    relay.datagram_received(packet, address)

    assert any(forwarded == packet and target == address for forwarded, target in transport.sent)


def test_an_unexpected_participant_is_not_forwarded_anywhere() -> None:
    relay, transport = _relay([0.0])
    relay.expect("room-1", "host")

    relay.datagram_received(_packet("stranger", 123), ("203.0.113.5", 5555))

    assert transport.sent == []


def test_rooms_do_not_leak_audio_into_each_other() -> None:
    relay, transport = _relay([0.0])
    host = relay.expect("room-1", "host")
    guest = relay.expect("room-1", "guest")
    relay.expect("room-2", "other-host")
    other_guest = relay.expect("room-2", "other-guest")
    relay.datagram_received(_packet("guest", guest), ("10.0.0.1", 1))
    relay.datagram_received(_packet("other-guest", other_guest), ("10.0.0.2", 2))

    relay.datagram_received(_packet("host", host), ("10.0.0.3", 3))

    assert transport.sent == [(_packet("host", guest), ("10.0.0.1", 1))]


def test_forgetting_a_participant_stops_relaying_to_or_from_them() -> None:
    relay, transport = _relay([0.0])
    host = relay.expect("room-1", "host")
    guest = relay.expect("room-1", "guest")
    relay.datagram_received(_packet("guest", guest), ("10.0.0.1", 1))

    relay.forget("guest")
    relay.datagram_received(_packet("host", host), ("10.0.0.3", 3))
    relay.datagram_received(_packet("guest", guest), ("10.0.0.1", 1))

    assert transport.sent == []


def test_a_member_who_stops_sending_is_dropped_after_the_staleness_window() -> None:
    clock = [0.0]
    relay, transport = _relay(clock)
    host = relay.expect("room-1", "host")
    guest = relay.expect("room-1", "guest")
    relay.datagram_received(_packet("guest", guest), ("10.0.0.1", 1))

    clock[0] = 999.0
    relay.datagram_received(_packet("host", host), ("10.0.0.3", 3))

    assert transport.sent == []


def test_malformed_or_undersized_packets_are_ignored() -> None:
    relay, transport = _relay([0.0])
    relay.expect("room-1", "host")

    relay.datagram_received(b"short", ("10.0.0.1", 1))
    relay.datagram_received(
        struct.pack("<III", 0, 0, participant_key("host")) + b"pad", ("10.0.0.1", 1)
    )

    assert transport.sent == []


def test_a_valid_token_cannot_impersonate_another_participant() -> None:
    relay, transport = _relay([0.0])
    host_token = relay.expect("room-1", "host")
    relay.expect("room-1", "guest")

    relay.datagram_received(_packet("guest", host_token), ("10.0.0.9", 9))

    assert transport.sent == []


def test_central_room_mix_never_offers_a_direct_peer_bypass() -> None:
    relay, _transport = _relay([0.0])
    host_token = relay.expect("room-1", "host", machine_id="same-pc")
    guest_token = relay.expect("room-1", "guest", machine_id="same-pc")
    relay.register_local_port("room-1", "host", host_token, 41001)
    relay.register_local_port("room-1", "guest", guest_token, 41002)
    relay.datagram_received(_packet("host", host_token), ("198.51.100.9", 51001))
    relay.datagram_received(_packet("guest", guest_token), ("198.51.100.9", 51002))

    assert relay.direct_peers("room-1", "host", host_token) == []


def test_same_router_participants_still_cannot_bypass_the_central_mix() -> None:
    relay, _transport = _relay([0.0])
    host_token = relay.expect("room-1", "host", machine_id="desktop")
    guest_token = relay.expect("room-1", "guest", machine_id="laptop")
    relay.register_local_port("room-1", "host", host_token, 41001, ("192.168.1.10", "172.20.0.1"))
    relay.register_local_port(
        "room-1", "guest", guest_token, 41002, ("169.254.3.3", "10.8.0.2", "192.168.1.23")
    )
    relay.datagram_received(_packet("host", host_token), ("176.37.224.136", 51001))
    relay.datagram_received(_packet("guest", guest_token), ("176.37.224.136", 62002))

    assert relay.direct_peers("room-1", "host", host_token) == []
    assert relay.direct_peers("room-1", "guest", guest_token) == []


def test_different_router_participants_still_cannot_bypass_the_central_mix() -> None:
    relay, _transport = _relay([0.0])
    host_token = relay.expect("room-1", "host", machine_id="desktop")
    guest_token = relay.expect("room-1", "guest", machine_id="laptop")
    relay.register_local_port("room-1", "host", host_token, 41001, ("192.168.1.10",))
    relay.register_local_port("room-1", "guest", guest_token, 41002, ("192.168.1.23",))
    relay.datagram_received(_packet("host", host_token), ("176.37.224.136", 51001))
    relay.datagram_received(_packet("guest", guest_token), ("203.0.113.5", 62002))

    assert relay.direct_peers("room-1", "host", host_token) == []


def test_direct_peer_discovery_rejects_a_token_from_another_identity() -> None:
    relay, _transport = _relay([0.0])
    relay.expect("room-1", "host", machine_id="host-pc")
    guest_token = relay.expect("room-1", "guest", machine_id="guest-pc")
    relay.datagram_received(_packet("guest", guest_token), ("203.0.113.5", 5555))

    assert relay.direct_peers("room-1", "host", guest_token) == []


def test_the_relay_socket_forwards_on_its_own_thread_while_the_caller_is_busy() -> None:
    relay = VoiceRelay()
    relay_socket = RelaySocket(relay, 0)
    relay_socket.start()
    host, guest = (socket.socket(socket.AF_INET, socket.SOCK_DGRAM) for _ in range(2))
    try:
        for client in (host, guest):
            client.bind(("127.0.0.1", 0))
            client.settimeout(2.0)
        host_token = relay.expect("room-1", "host")
        guest_token = relay.expect("room-1", "guest")
        target = ("127.0.0.1", relay_socket.port)
        # One socket, one thread: the guest packet (which teaches the relay its address) is
        # routed before the host packet that follows it.
        guest.sendto(_packet("guest", guest_token), target)
        started = time.perf_counter()
        host.sendto(_packet("host", host_token, 2), target)
        forwarded, _ = guest.recvfrom(4096)
        # No event loop is running here at all: forwarding depends only on the relay thread.
        assert time.perf_counter() - started < 0.5
        assert struct.unpack_from("<Q", forwarded, 16)[0] == guest_token
    finally:
        host.close()
        guest.close()
        stopping = time.perf_counter()
        relay_socket.stop()
        assert time.perf_counter() - stopping < 2.0
