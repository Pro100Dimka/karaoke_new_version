from __future__ import annotations

import asyncio
import secrets
import struct
import time
from dataclasses import dataclass
from typing import Callable, cast

# Must match the wire format AudioService writes in NetworkAudioEngine.cpp (PacketHeader / participantKey()).
_MAGIC = 0x32445541  # "AUD2"
_WIRE_PREFIX = struct.Struct("<IHHIIQ")
_WIRE_TOKEN = struct.Struct("<Q")
_WIRE_TOKEN_OFFSET = 16
# The relay only authenticates and routes packets, so it can remain compatible with installed
# clients while the payload/header grows. The participant key and token stay in this common prefix.
_WIRE_HEADER_BYTES_BY_VERSION = ((1, 36), (3, 44))
_MINIMUM_PACKET_BYTES = _WIRE_PREFIX.size
_STALE_MEMBER_SECONDS = (
    30.0  # a participant who stops sending audio is dropped so relaying does not keep them
)


def participant_key(participant_id: str) -> int:
    """The 32-bit FNV-1a hash AudioService derives from a participant id (see NetworkAudioEngine::participantKey)."""
    value = 2166136261
    for byte in participant_id.encode("utf-8"):
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value or 1


@dataclass(slots=True)
class _Member:
    address: tuple[str, int]
    last_seen: float
    last_probe_echo: float


class VoiceRelay(asyncio.DatagramProtocol):
    """Forwards AudioService voice packets between the participants of a room without decoding the audio.

    A participant must be ``expect``-ed (room + id) before their packets are relayed anywhere, which ties voice
    traffic to actual room membership. Their real address is learned from the first packet they send, since it may
    sit behind NAT and differ from any address the app itself could report.
    """

    def __init__(self, *, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._key_room: dict[int, str] = {}
        self._key_participant: dict[int, str] = {}
        self._key_machine: dict[int, str] = {}
        self._key_local_port: dict[int, int] = {}
        self._key_token: dict[int, int] = {}
        self._token_identity: dict[int, tuple[str, int]] = {}
        self._rooms: dict[str, dict[int, _Member]] = {}
        self._transport: asyncio.DatagramTransport | None = None

    def expect(self, room_id: str, participant_id: str, *, machine_id: str = "") -> int:
        key = participant_key(participant_id)
        previous = self._key_token.pop(key, None)
        if previous is not None:
            self._token_identity.pop(previous, None)
        token = secrets.randbits(64) or 1
        while token in self._token_identity:
            token = secrets.randbits(64) or 1
        self._key_room[key] = room_id
        self._key_participant[key] = participant_id
        self._key_machine[key] = machine_id
        self._key_token[key] = token
        self._token_identity[token] = (room_id, key)
        return token

    def register_local_port(
        self, room_id: str, participant_id: str, token: int, local_port: int
    ) -> bool:
        key = participant_key(participant_id)
        if (
            not 0 < local_port <= 65535
            or self._token_identity.get(token) != (room_id, key)
        ):
            return False
        self._key_local_port[key] = local_port
        return True

    def direct_peers(
        self, room_id: str, participant_id: str, token: int
    ) -> list[dict[str, str | int]]:
        requester_key = participant_key(participant_id)
        if self._token_identity.get(token) != (room_id, requester_key):
            return []
        requester_machine = self._key_machine.get(requester_key, "")
        peers: list[dict[str, str | int]] = []
        for key, peer_id in self._key_participant.items():
            if key == requester_key or self._key_room.get(key) != room_id:
                continue
            peer_token = self._key_token.get(key)
            if peer_token is None:
                continue
            same_machine = bool(requester_machine) and self._key_machine.get(key) == requester_machine
            if same_machine:
                host = "127.0.0.1"
                port = self._key_local_port.get(key)
            else:
                member = self._rooms.get(room_id, {}).get(key)
                host, port = member.address if member is not None else ("", None)
            if not host or port is None:
                continue
            peers.append(
                {
                    "participantId": peer_id,
                    "host": host,
                    "port": port,
                    "voiceToken": f"{peer_token:016x}",
                }
            )
        return peers

    def authenticates(self, room_id: str, participant_id: str, token: int) -> bool:
        return self._token_identity.get(token) == (room_id, participant_key(participant_id))

    def forget(self, participant_id: str) -> None:
        key = participant_key(participant_id)
        token = self._key_token.pop(key, None)
        if token is not None:
            self._token_identity.pop(token, None)
        room_id = self._key_room.pop(key, None)
        self._key_participant.pop(key, None)
        self._key_machine.pop(key, None)
        self._key_local_port.pop(key, None)
        if room_id is not None:
            self._rooms.get(room_id, {}).pop(key, None)

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        # asyncio always hands a real DatagramTransport here; the cast just lets a test double stand in for it.
        self._transport = cast(asyncio.DatagramTransport, transport)

    def datagram_received(self, data: bytes, address: tuple[str, int]) -> None:
        if len(data) < _MINIMUM_PACKET_BYTES:
            return
        magic, version, header_bytes, _sequence, key, token = _WIRE_PREFIX.unpack_from(data, 0)
        expected_header_bytes = next(
            (
                size
                for supported_version, size in _WIRE_HEADER_BYTES_BY_VERSION
                if supported_version == version
            ),
            None,
        )
        if (
            magic != _MAGIC
            or expected_header_bytes is None
            or header_bytes != expected_header_bytes
            or len(data) < header_bytes
        ):
            return
        identity = self._token_identity.get(token)
        if identity is None or identity[1] != key:
            return
        room_id = identity[0]
        members = self._rooms.setdefault(room_id, {})
        now = self._now()
        previous = members.get(key)
        members[key] = _Member(
            address,
            now,
            previous.last_probe_echo if previous is not None else now,
        )
        self._forward(room_id, key, data)

    def _forward(self, room_id: str, sender_key: int, data: bytes) -> None:
        if self._transport is None:
            return
        members = self._rooms[room_id]
        now = self._now()
        cutoff = now - _STALE_MEMBER_SECONDS
        for key in [key for key, member in members.items() if member.last_seen < cutoff]:
            del members[key]
        for key, member in members.items():
            if key != sender_key:
                recipient_token = self._key_token.get(key)
                if recipient_token is None:
                    continue
                forwarded = bytearray(data)
                _WIRE_TOKEN.pack_into(forwarded, _WIRE_TOKEN_OFFSET, recipient_token)
                self._transport.sendto(bytes(forwarded), member.address)
            elif now - member.last_probe_echo >= 1.0:
                # The client recognizes its own key as an RTT probe and never mixes it as audio.
                self._transport.sendto(data, member.address)
                member.last_probe_echo = now

    def error_received(self, exc: Exception) -> None:
        del exc  # A send to a peer whose address has become unreachable is not fatal to the relay.
