from __future__ import annotations

import socket
import struct
import time

from backend.infrastructure.voice_relay import RelaySocket, VoiceRelay, participant_key

_MAGIC = 0x32445541


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


class _FakeTransport:
    def __init__(self) -> None:
        self.sent: list[tuple[bytes, tuple[str, int]]] = []

    def sendto(self, data: bytes, address: tuple[str, int]) -> None:
        self.sent.append((data, address))


def _relay(clock: list[float]) -> tuple[VoiceRelay, _FakeTransport]:
    relay = VoiceRelay(now=lambda: clock[0])
    transport = _FakeTransport()
    relay.connection_made(transport)
    return relay, transport


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


def test_authenticated_room_members_receive_a_direct_peer_candidate_with_relay_fallback() -> None:
    relay, _transport = _relay([0.0])
    host_token = relay.expect("room-1", "host", machine_id="same-pc")
    guest_token = relay.expect("room-1", "guest", machine_id="same-pc")
    relay.register_local_port("room-1", "host", host_token, 41001)
    relay.register_local_port("room-1", "guest", guest_token, 41002)
    relay.datagram_received(_packet("host", host_token), ("198.51.100.9", 51001))
    relay.datagram_received(_packet("guest", guest_token), ("198.51.100.9", 51002))

    assert relay.direct_peers("room-1", "host", host_token) == [
        {
            "participantId": "guest",
            "host": "127.0.0.1",
            "port": 41002,
            "voiceToken": f"{guest_token:016x}",
        }
    ]


def test_two_computers_behind_one_router_are_given_each_others_home_network_address() -> None:
    relay, _transport = _relay([0.0])
    host_token = relay.expect("room-1", "host", machine_id="desktop")
    guest_token = relay.expect("room-1", "guest", machine_id="laptop")
    relay.register_local_port("room-1", "host", host_token, 41001, ("192.168.1.10", "172.20.0.1"))
    relay.register_local_port(
        "room-1", "guest", guest_token, 41002, ("169.254.3.3", "10.8.0.2", "192.168.1.23")
    )
    relay.datagram_received(_packet("host", host_token), ("176.37.224.136", 51001))
    relay.datagram_received(_packet("guest", guest_token), ("176.37.224.136", 62002))

    # The same subnet as the requester wins over a VPN address; link-local is never offered.
    assert relay.direct_peers("room-1", "host", host_token) == [
        {"participantId": "guest", "host": "192.168.1.23", "port": 41002,
         "voiceToken": f"{guest_token:016x}"}
    ]
    assert relay.direct_peers("room-1", "guest", guest_token)[0]["host"] == "192.168.1.10"


def test_peers_behind_different_routers_keep_their_public_address() -> None:
    relay, _transport = _relay([0.0])
    host_token = relay.expect("room-1", "host", machine_id="desktop")
    guest_token = relay.expect("room-1", "guest", machine_id="laptop")
    relay.register_local_port("room-1", "host", host_token, 41001, ("192.168.1.10",))
    relay.register_local_port("room-1", "guest", guest_token, 41002, ("192.168.1.23",))
    relay.datagram_received(_packet("host", host_token), ("176.37.224.136", 51001))
    relay.datagram_received(_packet("guest", guest_token), ("203.0.113.5", 62002))

    peer = relay.direct_peers("room-1", "host", host_token)[0]
    assert (peer["host"], peer["port"]) == ("203.0.113.5", 62002)


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
