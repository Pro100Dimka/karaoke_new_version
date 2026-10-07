"""The AudioService voice packet format, as the relay reads and writes it."""

from __future__ import annotations

import struct
from dataclasses import dataclass

from backend.room.voice_protocol import VOICE_SAMPLE_RATE_HZ

# Must match the wire format AudioService writes in NetworkAudioEngine.cpp (PacketHeader / participantKey()).
MAGIC = 0x32445541  # "AUD2"
WIRE_PREFIX = struct.Struct("<IHHIIQ")
WIRE_TOKEN = struct.Struct("<Q")
WIRE_PCM = struct.Struct("<IHHIIQQBBHII")
WIRE_TOKEN_OFFSET = 16
# The relay only authenticates and routes packets, so it can remain compatible with installed
# clients while the payload/header grows. The participant key and token stay in this common prefix.
WIRE_HEADER_BYTES_BY_VERSION = ((1, 36), (3, 44))
MINIMUM_PACKET_BYTES = WIRE_PREFIX.size
SHARED_TIMELINE_FLAG = 1 << 63
PCM16_CODEC = 1
SERVER_MIX_PARTICIPANT_ID = "__room_server_mix__"


def participant_key(participant_id: str) -> int:
    """The 32-bit FNV-1a hash AudioService derives from a participant id (see NetworkAudioEngine::participantKey)."""
    value = 2166136261
    for byte in participant_id.encode("utf-8"):
        value ^= byte
        value = (value * 16777619) & 0xFFFFFFFF
    return value or 1


def media_frame(timestamp: int) -> int:
    """A shared-timeline timestamp without its flag: the musical position in frames."""
    return timestamp & ~SHARED_TIMELINE_FLAG


@dataclass(frozen=True, slots=True)
class PacketIdentity:
    key: int
    token: int


def packet_identity(data: bytes) -> PacketIdentity | None:
    """The sender key and session token of a well-formed packet of a supported version."""
    if len(data) < MINIMUM_PACKET_BYTES:
        return None
    magic, version, header_bytes, _sequence, key, token = WIRE_PREFIX.unpack_from(data, 0)
    expected_header_bytes = next(
        (
            size
            for supported_version, size in WIRE_HEADER_BYTES_BY_VERSION
            if supported_version == version
        ),
        None,
    )
    if (
        magic != MAGIC
        or expected_header_bytes is None
        or header_bytes != expected_header_bytes
        or len(data) < header_bytes
    ):
        return None
    return PacketIdentity(key, token)


@dataclass(frozen=True, slots=True)
class PcmPosition:
    timestamp: int
    frames: int
    samples: tuple[int, ...]
    ingress_lateness_frames: int


def parse_pcm_position(data: bytes, wall_now: float) -> PcmPosition | None:
    if len(data) < WIRE_PCM.size:
        return None
    fields = WIRE_PCM.unpack_from(data)
    version, header_bytes, timestamp, channels, codec, frames = (
        fields[1],
        fields[2],
        fields[6],
        fields[7],
        fields[8],
        fields[9],
    )
    valid = (
        version == 3
        and header_bytes == WIRE_PCM.size
        and timestamp & SHARED_TIMELINE_FLAG != 0
        and channels == 1
        and codec == PCM16_CODEC
        and frames > 0
        and len(data) == header_bytes + frames * 2
    )
    if not valid:
        return None
    samples = struct.unpack_from(f"<{frames}h", data, header_bytes)
    arrival_frame = max(0, round(wall_now * VOICE_SAMPLE_RATE_HZ))
    ingress_lateness = max(0, arrival_frame - media_frame(timestamp))
    return PcmPosition(timestamp, frames, samples, ingress_lateness)


@dataclass(frozen=True, slots=True)
class MixHeader:
    sequence: int
    mix_key: int
    token: int
    timestamp: int
    frames: int
    stage_report: int
    epoch: int


def mix_packet(header: MixHeader, samples: tuple[int, ...]) -> bytes:
    packed = WIRE_PCM.pack(
        MAGIC,
        3,
        WIRE_PCM.size,
        header.sequence,
        header.mix_key,
        header.token,
        header.timestamp,
        1,
        PCM16_CODEC,
        header.frames,
        header.stage_report,
        header.epoch,
    )
    return packed + struct.pack(f"<{header.frames}h", *samples)


def mix_samples(packet: bytes, frames: int) -> tuple[int, ...]:
    return tuple(struct.unpack_from(f"<{frames}h", packet, WIRE_PCM.size))


def has_audio(packet: bytes) -> bool:
    return any(packet[WIRE_PCM.size :])


def readdressed(data: bytes, token: int) -> bytes:
    """The same packet carrying another recipient's session token."""
    forwarded = bytearray(data)
    WIRE_TOKEN.pack_into(forwarded, WIRE_TOKEN_OFFSET, token)
    return bytes(forwarded)
