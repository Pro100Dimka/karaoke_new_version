from __future__ import annotations

import logging
import secrets
import socket
import struct
import threading
import time
from dataclasses import dataclass
from typing import Callable, Protocol

from backend.infrastructure.job_executor import ServiceLoop

# Must match the wire format AudioService writes in NetworkAudioEngine.cpp (PacketHeader / participantKey()).
_MAGIC = 0x32445541  # "AUD2"
_WIRE_PREFIX = struct.Struct("<IHHIIQ")
_WIRE_TOKEN = struct.Struct("<Q")
_WIRE_V3 = struct.Struct("<IHHIIQQBBHII")
_WIRE_TOKEN_OFFSET = 16
# The relay only authenticates and routes packets, so it can remain compatible with installed
# clients while the payload/header grows. The participant key and token stay in this common prefix.
_WIRE_HEADER_BYTES_BY_VERSION = ((1, 36), (3, 44))
_MINIMUM_PACKET_BYTES = _WIRE_PREFIX.size
_STALE_MEMBER_SECONDS = (
    30.0  # a participant who stops sending audio is dropped so relaying does not keep them
)
_MAXIMUM_DATAGRAM_BYTES = 65_535
_SHARED_TIMELINE_FLAG = 1 << 63
_PCM16_CODEC = 1
_SERVER_MIX_PARTICIPANT_ID = "__room_server_mix__"
_MIX_COLLECTION_SECONDS = 0.0075
_RETURN_ROUTE_RESERVE_SECONDS = 0.020
_EXCLUSION_MISSES = 3  # one isolated 2.5 ms loss must not mute a singer for the recovery window
_RECOVERY_PACKETS = 200  # 0.5 s at the AudioService packet rate
_TIMELINE_RESTART_FRAMES = 48_000  # tolerate reordering, but reset after a >1 s rewind

logger = logging.getLogger(__name__)


class DatagramSender(Protocol):
    def sendto(self, data: bytes, address: tuple[str, int]) -> object: ...


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


@dataclass(frozen=True, slots=True)
class _PcmPosition:
    timestamp: int
    frames: int
    samples: tuple[int, ...]
    ingress_lateness_frames: int


@dataclass(slots=True)
class _PendingPcm:
    samples: list[int]
    present: list[bool]
    ingress_lateness_frames: int

    @classmethod
    def empty(cls, frames: int, ingress_lateness_frames: int) -> _PendingPcm:
        return cls([0] * frames, [False] * frames, ingress_lateness_frames)

    def write(self, offset: int, values: tuple[int, ...]) -> None:
        self.samples[offset : offset + len(values)] = values
        self.present[offset : offset + len(values)] = [True] * len(values)

    def complete(self) -> bool:
        missing = [index for index, present in enumerate(self.present) if not present]
        if not missing:
            return True
        if len(missing) != 1:
            return False
        # Scaling a continuous 44.1 kHz capture timeline to 48 kHz can leave one frame between
        # adjacent 120-frame packets (the inverse rounding produces an overlap elsewhere). This
        # is not packet loss: interpolate that single sample so one harmless rounding point does
        # not discard an entire 2.5 ms musical position.
        index = missing[0]
        left = self.samples[index - 1] if index > 0 and self.present[index - 1] else None
        right = (
            self.samples[index + 1]
            if index + 1 < len(self.samples) and self.present[index + 1]
            else None
        )
        if left is None and right is None:
            return False
        self.samples[index] = right if left is None else left if right is None else (left + right) // 2
        self.present[index] = True
        return True


class VoiceRelay:
    """Forwards AudioService voice packets between the participants of a room without decoding the audio.

    A participant must be ``expect``-ed (room + id) before their packets are relayed anywhere, which ties voice
    traffic to actual room membership. Their real address is learned from the first packet they send, since it may
    sit behind NAT and differ from any address the app itself could report.

    Packets arrive on the ``RelaySocket`` thread while HTTP handlers register and forget participants on
    their own threads, so one lock guards the membership state.
    """

    def __init__(
        self,
        *,
        now: Callable[[], float] = time.monotonic,
        wall_now: Callable[[], float] = time.time,
        mix_packet_copies: int = 2,
    ) -> None:
        self._now = now
        self._wall_now = wall_now
        self._mix_packet_copies = max(1, mix_packet_copies)
        self._lock = threading.Lock()
        self._key_room: dict[int, str] = {}
        self._key_participant: dict[int, str] = {}
        self._key_token: dict[int, int] = {}
        self._token_identity: dict[int, tuple[str, int]] = {}
        self._rooms: dict[str, dict[int, _Member]] = {}
        self._pending_mix: dict[str, dict[tuple[int, int], dict[int, _PendingPcm]]] = {}
        self._pending_mix_started: dict[str, dict[tuple[int, int], float]] = {}
        self._pending_mix_arrived: dict[str, dict[tuple[int, int], float]] = {}
        self._room_playout_delay_seconds: dict[str, float] = {}
        self._room_eligible_mixers: dict[str, set[int]] = {}
        self._mixed_positions: dict[str, set[tuple[int, int]]] = {}
        self._excluded_mixers: dict[str, set[int]] = {}
        self._deadline_misses: dict[tuple[str, int], int] = {}
        self._recovery_packets: dict[tuple[str, int], int] = {}
        self._recovery_next_frame: dict[tuple[str, int], int] = {}
        self._mix_sequences: dict[tuple[str, int], int] = {}
        self._mix_epochs: dict[str, int] = {}
        self._latest_mix_input_end: dict[str, int] = {}
        self._transport: DatagramSender | None = None

    def set_room_playout_delay(self, room_id: str, milliseconds: float | None) -> None:
        """Use the room's fixed deadline for every musical position, not packet arrival order."""
        with self._lock:
            seconds = None if milliseconds is None else max(0.0, milliseconds / 1_000.0)
            if self._room_playout_delay_seconds.get(room_id) == seconds:
                return
            if seconds is None:
                self._room_playout_delay_seconds.pop(room_id, None)
            else:
                self._room_playout_delay_seconds[room_id] = seconds
            self._pending_mix.pop(room_id, None)
            self._pending_mix_started.pop(room_id, None)
            self._pending_mix_arrived.pop(room_id, None)
            self._mixed_positions.pop(room_id, None)
            self._excluded_mixers.pop(room_id, None)
            for key in [key for key in self._deadline_misses if key[0] == room_id]:
                self._deadline_misses.pop(key, None)
            for key in [key for key in self._recovery_packets if key[0] == room_id]:
                self._recovery_packets.pop(key, None)
                self._recovery_next_frame.pop(key, None)

    def set_room_eligible_participants(
        self, room_id: str, participant_ids: set[str] | None
    ) -> None:
        """Keep listeners connected without letting an ineligible singer delay or enter the mix."""
        with self._lock:
            eligible = (
                None
                if participant_ids is None
                else {participant_key(participant_id) for participant_id in participant_ids}
            )
            if self._room_eligible_mixers.get(room_id) == eligible:
                return
            if eligible is None:
                self._room_eligible_mixers.pop(room_id, None)
            else:
                self._room_eligible_mixers[room_id] = eligible
            self._pending_mix.pop(room_id, None)
            self._pending_mix_started.pop(room_id, None)
            self._pending_mix_arrived.pop(room_id, None)
            self._mixed_positions.pop(room_id, None)
            self._excluded_mixers.pop(room_id, None)
            for key in [key for key in self._deadline_misses if key[0] == room_id]:
                self._deadline_misses.pop(key, None)
            for key in [key for key in self._recovery_packets if key[0] == room_id]:
                self._recovery_packets.pop(key, None)
                self._recovery_next_frame.pop(key, None)

    def expect(self, room_id: str, participant_id: str, *, machine_id: str = "") -> int:
        with self._lock:
            key = participant_key(participant_id)
            previous = self._key_token.pop(key, None)
            if previous is not None:
                self._token_identity.pop(previous, None)
            token = secrets.randbits(64) or 1
            while token in self._token_identity:
                token = secrets.randbits(64) or 1
            self._key_room[key] = room_id
            self._key_participant[key] = participant_id
            self._key_token[key] = token
            self._token_identity[token] = (room_id, key)
            return token

    def register_local_port(
        self,
        room_id: str,
        participant_id: str,
        token: int,
        local_port: int,
        local_hosts: tuple[str, ...] = (),
    ) -> bool:
        """Authenticates legacy candidate metadata without enabling a direct audio route."""
        with self._lock:
            key = participant_key(participant_id)
            return 0 < local_port <= 65535 and self._token_identity.get(token) == (room_id, key)

    def direct_peers(
        self, room_id: str, participant_id: str, token: int
    ) -> list[dict[str, str | int]]:
        with self._lock:
            requester_key = participant_key(participant_id)
            if self._token_identity.get(token) != (room_id, requester_key):
                return []
            # Room audio is mixed centrally. A direct route would bypass the server's musical
            # deadline and recreate a different mix on every computer.
            return []

    def authenticates(self, room_id: str, participant_id: str, token: int) -> bool:
        with self._lock:
            return self._token_identity.get(token) == (room_id, participant_key(participant_id))

    def forget(self, participant_id: str) -> None:
        with self._lock:
            key = participant_key(participant_id)
            token = self._key_token.pop(key, None)
            if token is not None:
                self._token_identity.pop(token, None)
            room_id = self._key_room.pop(key, None)
            self._key_participant.pop(key, None)
            if room_id is not None:
                self._rooms.get(room_id, {}).pop(key, None)
                self._deadline_misses.pop((room_id, key), None)
                self._recovery_packets.pop((room_id, key), None)
                self._recovery_next_frame.pop((room_id, key), None)

    def connection_made(self, transport: DatagramSender) -> None:
        self._transport = transport

    def datagram_received(self, data: bytes, address: tuple[str, int]) -> None:
        with self._lock:
            self._route(data, address)

    def flush_due(self) -> None:
        """Publish positions whose fixed collection deadline expired without every singer."""
        with self._lock:
            self._flush_due_locked(self._now())

    def _route(self, data: bytes, address: tuple[str, int]) -> None:
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
        self._flush_due_locked(now)
        if self._mix_pcm_position(room_id, key, data):
            member = members[key]
            if self._transport is not None and now - member.last_probe_echo >= 1.0:
                self._transport.sendto(data, member.address)
                member.last_probe_echo = now
            return
        self._forward(room_id, key, data)

    def _mix_pcm_position(self, room_id: str, sender_key: int, data: bytes) -> bool:
        """Mix one shared-timeline PCM position once every expected singer has supplied it."""
        packet = self._parse_pcm_position(data, self._wall_now())
        if packet is None:
            return False
        self._prepare_mix_timeline(room_id, packet)
        self._advance_recovery(
            room_id,
            sender_key,
            packet.timestamp,
            packet.frames,
            packet.ingress_lateness_frames,
        )
        touched = self._store_pcm_segments(room_id, sender_key, packet)
        for position in touched:
            inputs = self._pending_mix.get(room_id, {}).get(position)
            if inputs is not None and self._inputs_complete(room_id, inputs):
                for key in self._expected_mixers(room_id):
                    self._deadline_misses.pop((room_id, key), None)
                self._finish_mix_position(room_id, position, inputs)
        return True

    def _prepare_mix_timeline(self, room_id: str, packet: _PcmPosition) -> None:
        start = packet.timestamp & ~_SHARED_TIMELINE_FLAG
        latest_end = self._latest_mix_input_end.get(room_id)
        if latest_end is not None and start + _TIMELINE_RESTART_FRAMES < latest_end:
            # A new performance (or a backward seek) may legitimately reuse the same musical
            # positions. Retained duplicate protection belongs only to the previous performance.
            self._pending_mix.pop(room_id, None)
            self._pending_mix_started.pop(room_id, None)
            self._pending_mix_arrived.pop(room_id, None)
            self._mixed_positions.pop(room_id, None)
            self._excluded_mixers.pop(room_id, None)
            for key in [key for key in self._deadline_misses if key[0] == room_id]:
                self._deadline_misses.pop(key, None)
            for key in [key for key in self._recovery_packets if key[0] == room_id]:
                self._recovery_packets.pop(key, None)
                self._recovery_next_frame.pop(key, None)
            epoch = (self._mix_epochs.get(room_id, 1) + 1) & 0xFFFF_FFFF
            self._mix_epochs[room_id] = epoch or 1
            latest_end = None
        self._latest_mix_input_end[room_id] = max(latest_end or 0, start + packet.frames)

    @staticmethod
    def _parse_pcm_position(data: bytes, wall_now: float) -> _PcmPosition | None:
        if len(data) < _WIRE_V3.size:
            return None
        fields = _WIRE_V3.unpack_from(data)
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
            and header_bytes == _WIRE_V3.size
            and timestamp & _SHARED_TIMELINE_FLAG != 0
            and channels == 1
            and codec == _PCM16_CODEC
            and frames > 0
            and len(data) == header_bytes + frames * 2
        )
        if not valid:
            return None
        samples = struct.unpack_from(f"<{frames}h", data, header_bytes)
        media_timestamp = timestamp & ~_SHARED_TIMELINE_FLAG
        arrival_frame = max(0, round(wall_now * 48_000.0))
        ingress_lateness = max(0, arrival_frame - media_timestamp)
        return _PcmPosition(timestamp, frames, samples, ingress_lateness)

    def _store_pcm_segments(
        self, room_id: str, sender_key: int, packet: _PcmPosition
    ) -> set[tuple[int, int]]:
        media_start = packet.timestamp & ~_SHARED_TIMELINE_FLAG
        media_end = media_start + packet.frames
        bin_start = media_start // packet.frames * packet.frames
        touched: set[tuple[int, int]] = set()
        while bin_start < media_end:
            position = (bin_start | _SHARED_TIMELINE_FLAG, packet.frames)
            touched.add(position)
            self._store_pcm_overlap(room_id, sender_key, packet, position)
            bin_start += packet.frames
        return touched

    def _store_pcm_overlap(
        self,
        room_id: str,
        sender_key: int,
        packet: _PcmPosition,
        position: tuple[int, int],
    ) -> None:
        if position in self._mixed_positions.setdefault(room_id, set()):
            return  # an expired/duplicate sample is never emitted on a later beat
        bin_start, frames = position[0] & ~_SHARED_TIMELINE_FLAG, position[1]
        media_start = packet.timestamp & ~_SHARED_TIMELINE_FLAG
        overlap_start = max(bin_start, media_start)
        overlap_end = min(bin_start + frames, media_start + packet.frames)
        if overlap_start >= overlap_end:
            return
        inputs = self._pending_mix.setdefault(room_id, {}).setdefault(position, {})
        pending = inputs.setdefault(
            sender_key, _PendingPcm.empty(frames, packet.ingress_lateness_frames)
        )
        pending.ingress_lateness_frames = max(
            pending.ingress_lateness_frames, packet.ingress_lateness_frames
        )
        source_offset = overlap_start - media_start
        pending.write(
            overlap_start - bin_start,
            packet.samples[source_offset : source_offset + overlap_end - overlap_start],
        )
        started = self._now()
        delay = self._room_playout_delay_seconds.get(room_id)
        if delay is None:
            deadline = started + _MIX_COLLECTION_SECONDS
        else:
            due_wall = (
                bin_start / 48_000.0 + max(0.0, delay - _RETURN_ROUTE_RESERVE_SECONDS)
            )
            # Packet timestamps use the server's wall-clock musical epoch; scheduling uses
            # monotonic time. Comparing them directly left an incomplete position pending forever.
            deadline = started + max(0.0, due_wall - self._wall_now())
        self._pending_mix_started.setdefault(room_id, {}).setdefault(position, deadline)
        self._pending_mix_arrived.setdefault(room_id, {}).setdefault(position, started)

    def _inputs_complete(self, room_id: str, inputs: dict[int, _PendingPcm]) -> bool:
        expected = self._expected_mixers(room_id)
        return expected.issubset(inputs) and all(inputs[key].complete() for key in expected)

    def _expected_mixers(self, room_id: str) -> set[int]:
        excluded = self._excluded_mixers.setdefault(room_id, set())
        eligible = self._room_eligible_mixers.get(room_id)
        return {
            key
            for key, expected_room in self._key_room.items()
            if expected_room == room_id
            and key not in excluded
            and (eligible is None or key in eligible)
        }

    def _reset_recovery(self, room_id: str, sender_key: int) -> None:
        recovery_key = (room_id, sender_key)
        self._recovery_packets[recovery_key] = 0
        self._recovery_next_frame.pop(recovery_key, None)

    def _advance_recovery(
        self,
        room_id: str,
        sender_key: int,
        timestamp: int,
        frames: int,
        ingress_lateness_frames: int,
    ) -> None:
        excluded = self._excluded_mixers.setdefault(room_id, set())
        if sender_key not in excluded:
            return
        recovery_key = (room_id, sender_key)
        delay = self._room_playout_delay_seconds.get(room_id)
        on_time_frames = (
            None
            if delay is None
            else round(max(0.0, delay - _RETURN_ROUTE_RESERVE_SECONDS) * 48_000.0)
        )
        if on_time_frames is not None and ingress_lateness_frames > on_time_frames:
            self._reset_recovery(room_id, sender_key)
            return
        frame = timestamp & ~_SHARED_TIMELINE_FLAG
        next_frame = self._recovery_next_frame.get(recovery_key)
        if next_frame is not None and frame + frames == next_frame:
            return  # a redundant copy proves neither a new success nor a recovery failure
        consecutive = next_frame == frame
        recovered = self._recovery_packets.get(recovery_key, 0) + 1 if consecutive else 1
        self._recovery_packets[recovery_key] = recovered
        self._recovery_next_frame[recovery_key] = frame + frames
        if recovered >= _RECOVERY_PACKETS:
            excluded.remove(sender_key)
            self._reset_recovery(room_id, sender_key)

    def _flush_due_locked(self, now: float) -> None:
        for room_id, positions in tuple(self._pending_mix.items()):
            deadlines = self._pending_mix_started.get(room_id, {})
            excluded = self._excluded_mixers.setdefault(room_id, set())
            for position, inputs in tuple(positions.items()):
                if now < deadlines.get(position, now + _MIX_COLLECTION_SECONDS):
                    continue
                expected = {
                    key
                    for key, expected_room in self._key_room.items()
                    if expected_room == room_id and key not in excluded
                }
                complete = {key for key, samples in inputs.items() if samples.complete()}
                for key in expected.intersection(complete):
                    self._deadline_misses.pop((room_id, key), None)
                newly_excluded = set()
                for key in expected.difference(complete):
                    miss_key = (room_id, key)
                    misses = self._deadline_misses.get(miss_key, 0) + 1
                    self._deadline_misses[miss_key] = misses
                    if misses >= _EXCLUSION_MISSES:
                        newly_excluded.add(key)
                        self._deadline_misses.pop(miss_key, None)
                excluded.update(newly_excluded)
                for key in newly_excluded:
                    recovery_key = (room_id, key)
                    self._recovery_packets[recovery_key] = 0
                    self._recovery_next_frame.pop(recovery_key, None)
                self._finish_mix_position(room_id, position, inputs)

    def _finish_mix_position(
        self,
        room_id: str,
        position: tuple[int, int],
        inputs: dict[int, _PendingPcm],
    ) -> None:
        timestamp, frames = position
        expected = self._expected_mixers(room_id)
        audible = {
            key: tuple(samples.samples)
            for key, samples in inputs.items()
            if key in expected and samples.complete()
        }
        ingress = {
            key: samples.ingress_lateness_frames
            for key, samples in inputs.items()
            if key in audible
        }
        arrived = self._pending_mix_arrived.get(room_id, {}).get(position, self._now())
        mix_wait_frames = max(0, round((self._now() - arrived) * 48_000.0))
        self._emit_mix(room_id, timestamp, frames, audible, ingress, mix_wait_frames)
        self._pending_mix.get(room_id, {}).pop(position, None)
        self._pending_mix_started.get(room_id, {}).pop(position, None)
        self._pending_mix_arrived.get(room_id, {}).pop(position, None)
        mixed = self._mixed_positions.setdefault(room_id, set())
        mixed.add(position)
        # At 400 packets/s this retains ten seconds of duplicate/late-packet protection.
        if len(mixed) > 4_000:
            mixed.remove(min(mixed))

    def _emit_mix(
        self,
        room_id: str,
        timestamp: int,
        frames: int,
        inputs: dict[int, tuple[int, ...]],
        ingress: dict[int, int],
        mix_wait_frames: int,
    ) -> None:
        if self._transport is None:
            return
        members = self._rooms.get(room_id, {})
        mix_key = participant_key(_SERVER_MIX_PARTICIPANT_ID)
        for recipient_key, member in members.items():
            token = self._key_token.get(recipient_key)
            if token is None:
                continue
            packet = self._recipient_mix_packet(
                room_id,
                recipient_key,
                token,
                mix_key,
                timestamp,
                frames,
                inputs,
                ingress,
                mix_wait_frames,
            )
            # The room mix is PCM over UDP, so losing one datagram would otherwise insert
            # 2.5 ms of silence at this exact musical position. Identical copies keep the same
            # sequence/timestamp; AudioService accepts the first and discards the duplicate.
            for _ in range(self._mix_packet_copies):
                self._transport.sendto(packet, member.address)

    def _recipient_mix_packet(
        self, room_id: str, recipient_key: int, token: int, mix_key: int, timestamp: int,
        frames: int, inputs: dict[int, tuple[int, ...]], ingress: dict[int, int],
        mix_wait_frames: int,
    ) -> bytes:
        samples = tuple(
            max(
                -32_768,
                min(
                    32_767,
                    sum(voice[index] for key, voice in inputs.items() if key != recipient_key),
                ),
            )
            for index in range(frames)
        )
        sequence_key = (room_id, recipient_key)
        sequence = self._mix_sequences.get(sequence_key, 0)
        self._mix_sequences[sequence_key] = (sequence + 1) & 0xFFFF_FFFF
        remote_ingress_frames = max(
            (value for key, value in ingress.items() if key != recipient_key), default=0
        )
        stage_report = min(remote_ingress_frames, 0xFFFF) | (
            min(mix_wait_frames, 0xFFFF) << 16
        )
        header = _WIRE_V3.pack(
            _MAGIC,
            3,
            _WIRE_V3.size,
            sequence,
            mix_key,
            token,
            timestamp,
            1,
            _PCM16_CODEC,
            frames,
            stage_report,
            self._mix_epochs.get(room_id, 1),
        )
        return header + struct.pack(f"<{frames}h", *samples)

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


class RelaySocket:
    """Owns the UDP socket and the service thread that feeds ``VoiceRelay``.

    Voice runs on its own thread instead of the HTTP event loop: a room sweep, a database read or a
    request there used to hold every voice packet for tens of milliseconds.
    """

    # How often a quiet receive loop looks at the stop request; packets are never delayed by it.
    _STOP_POLL_SECONDS = 0.0025

    def __init__(self, relay: VoiceRelay, port: int) -> None:
        self._relay = relay
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.bind(("0.0.0.0", port))
        self._socket.settimeout(self._STOP_POLL_SECONDS)
        self._loop = ServiceLoop("voice-relay", self._receive_one, self._STOP_POLL_SECONDS)

    @property
    def port(self) -> int:
        return int(self._socket.getsockname()[1])

    def start(self) -> None:
        self._relay.connection_made(self._socket)
        self._loop.start()

    def stop(self) -> None:
        self._loop.stop()
        self._socket.close()

    def _receive_one(self) -> None:
        try:
            data, address = self._socket.recvfrom(_MAXIMUM_DATAGRAM_BYTES)
        except OSError:
            self._relay.flush_due()
            return  # the stop poll timeout, or an ICMP error from a departed peer
        try:
            self._relay.datagram_received(data, address)
        except OSError:
            # A send to one unreachable member must not stop the relay for everyone else.
            logger.warning("Voice relay could not forward a packet", exc_info=True)
