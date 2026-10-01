from __future__ import annotations

import socket
import struct
import time

from backend.infrastructure.voice_relay import RelaySocket, VoiceRelay, participant_key

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
    relay = VoiceRelay(now=lambda: clock[0], mix_packet_copies=1)
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
        expected = (11_000, 22_000) if sequence == 204 else (1_000, 2_000)
        assert _pcm_samples(packets_by_address[addresses["alice"]]) == expected


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
