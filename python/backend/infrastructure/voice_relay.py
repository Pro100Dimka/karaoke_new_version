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
_WIRE_VERSION = 1
_WIRE_HEADER_BYTES = 36
_MINIMUM_PACKET_BYTES = _WIRE_HEADER_BYTES
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


class VoiceRelay(asyncio.DatagramProtocol):
    """Forwards AudioService voice packets between the participants of a room without decoding the audio.

    A participant must be ``expect``-ed (room + id) before their packets are relayed anywhere, which ties voice
    traffic to actual room membership. Their real address is learned from the first packet they send, since it may
    sit behind NAT and differ from any address the app itself could report.
    """

    def __init__(self, *, now: Callable[[], float] = time.monotonic) -> None:
        self._now = now
        self._key_room: dict[int, str] = {}
        self._key_token: dict[int, int] = {}
        self._token_identity: dict[int, tuple[str, int]] = {}
        self._rooms: dict[str, dict[int, _Member]] = {}
        self._transport: asyncio.DatagramTransport | None = None

    def expect(self, room_id: str, participant_id: str) -> int:
        key = participant_key(participant_id)
        previous = self._key_token.pop(key, None)
        if previous is not None:
            self._token_identity.pop(previous, None)
        token = secrets.randbits(64) or 1
        while token in self._token_identity:
            token = secrets.randbits(64) or 1
        self._key_room[key] = room_id
        self._key_token[key] = token
        self._token_identity[token] = (room_id, key)
        return token

    def forget(self, participant_id: str) -> None:
        key = participant_key(participant_id)
        token = self._key_token.pop(key, None)
        if token is not None:
            self._token_identity.pop(token, None)
        room_id = self._key_room.pop(key, None)
        if room_id is not None:
            self._rooms.get(room_id, {}).pop(key, None)

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        # asyncio always hands a real DatagramTransport here; the cast just lets a test double stand in for it.
        self._transport = cast(asyncio.DatagramTransport, transport)

    def datagram_received(self, data: bytes, address: tuple[str, int]) -> None:
        if len(data) < _MINIMUM_PACKET_BYTES:
            return
        magic, version, header_bytes, _sequence, key, token = _WIRE_PREFIX.unpack_from(data, 0)
        if magic != _MAGIC or version != _WIRE_VERSION or header_bytes != _WIRE_HEADER_BYTES:
            return
        identity = self._token_identity.get(token)
        if identity is None or identity[1] != key:
            return
        room_id = identity[0]
        members = self._rooms.setdefault(room_id, {})
        members[key] = _Member(address, self._now())
        self._forward(room_id, key, data)

    def _forward(self, room_id: str, sender_key: int, data: bytes) -> None:
        if self._transport is None:
            return
        members = self._rooms[room_id]
        cutoff = self._now() - _STALE_MEMBER_SECONDS
        for key in [key for key, member in members.items() if member.last_seen < cutoff]:
            del members[key]
        for key, member in members.items():
            if key != sender_key:
                self._transport.sendto(data, member.address)

    def error_received(self, exc: Exception) -> None:
        del exc  # A send to a peer whose address has become unreachable is not fatal to the relay.
