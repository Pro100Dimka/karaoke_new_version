from __future__ import annotations

import logging
import math
import secrets
import socket
import struct
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Protocol

from backend.infrastructure.job_executor import ServiceLoop
from backend.room.timing_policy import ROOM_TIMING
from backend.room.voice_protocol import VOICE_PACKETS_PER_SECOND, VOICE_SAMPLE_RATE_HZ

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
_PARTICIPANT_LEVEL_STALE_SECONDS = 0.3
_SERVER_MIX_PARTICIPANT_ID = "__room_server_mix__"
_MIX_COLLECTION_SECONDS = ROOM_TIMING.collection_budget_ms / 1_000.0
_EXCLUSION_MISSES = 3  # one isolated 2.5 ms loss must not mute a singer for the recovery window
_EXCLUSION_GRACE_SECONDS = 0.5  # packet misses alone are degraded state, not a disconnect
_RECOVERY_PACKETS = 200  # 0.5 s at the AudioService packet rate
_RECIPIENT_SEND_STALL_SECONDS = 3 / VOICE_PACKETS_PER_SECOND  # three missing send slots form a burst
_PIPELINE_GAP_CLASSIFICATION_SECONDS = 0.020
_PIPELINE_GAP_REASONS = (
    "CLIENT_SEND_STALL",
    "NETWORK_OR_INGRESS_STALL",
    "POSITION_COLLECTION_STALL",
    "MIX_BUILD_STALL",
    "SENDTO_STALL",
    "SERVER_EVENT_LOOP_STALL",
    "CLIENT_RECEIVE_STALL",
    "SEEK_LIFECYCLE_STALL",
    "UNKNOWN",
)
_ENERGY_TRACE_PACKET_LIMIT = 2_000  # enough for diagnostics without tracing PCM forever
_TIMELINE_RESTART_FRAMES = VOICE_SAMPLE_RATE_HZ  # tolerate reordering, but reset after a >1 s rewind

logger = logging.getLogger(__name__)


class DatagramSender(Protocol):
    def sendto(self, data: bytes, address: tuple[str, int]) -> object: ...


_SLACK_KEYS = (
    "ingress_slack_packets",
    "ingress_slack_negative_packets",
    "ingress_slack_minimum_ms",
    "ingress_slack_p5_ms",
    "ingress_slack_p50_ms",
)


def _slack_summary(values: Iterable[float]) -> dict[str, float]:
    """How early a singer's packets reached their position's close (negative: too late)."""
    ordered = sorted(values)
    if not ordered:
        return {key: 0.0 for key in _SLACK_KEYS}
    return {
        "ingress_slack_packets": float(len(ordered)),
        "ingress_slack_negative_packets": float(sum(value < 0.0 for value in ordered)),
        "ingress_slack_minimum_ms": ordered[0],
        "ingress_slack_p5_ms": ordered[len(ordered) * 5 // 100],
        "ingress_slack_p50_ms": ordered[len(ordered) // 2],
    }


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

    def coverage(self) -> dict[str, object]:
        missing = [index for index, present in enumerate(self.present) if not present]
        ranges: list[list[int]] = []
        for index in missing:
            if not ranges or index != ranges[-1][1] + 1:
                ranges.append([index, index])
            else:
                ranges[-1][1] = index
        return {
            "expected_frames": len(self.present),
            "present_frames": len(self.present) - len(missing),
            "missing_frames": len(missing),
            "missing_ranges": ranges,
        }


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
        control_command: Callable[[str], None] | None = None,
        recipient_metrics: Callable[[str, str], dict[str, int | float]] | None = None,
        participant_levels: Callable[[str], dict[str, float]] | None = None,
    ) -> None:
        self._now = now
        self._wall_now = wall_now
        self._mix_packet_copies = max(1, mix_packet_copies)
        self._control_command = control_command
        self._recipient_metrics = recipient_metrics
        self._native_participant_levels = participant_levels
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
        self._room_return_reserve_seconds: dict[str, float] = {}
        self._room_eligible_mixers: dict[str, set[int]] = {}
        self._mixed_positions: dict[str, set[tuple[int, int]]] = {}
        self._excluded_mixers: dict[str, set[int]] = {}
        self._voice_started: dict[str, set[int]] = {}
        self._voice_activation_position: dict[tuple[str, int], int] = {}
        self._seen_pcm_positions: dict[str, dict[tuple[int, int], set[int]]] = {}
        self._seen_pcm_arrivals: dict[str, dict[tuple[int, int], dict[int, float]]] = {}
        self._miss_history: dict[tuple[str, int], list[dict[str, object]]] = {}
        self._deadline_misses: dict[tuple[str, int], int] = {}
        self._miss_started_at: dict[tuple[str, int], float] = {}
        self._recovery_packets: dict[tuple[str, int], int] = {}
        self._recovery_next_frame: dict[tuple[str, int], int] = {}
        self._mix_sequences: dict[tuple[str, int], int] = {}
        self._mix_epochs: dict[str, int] = {}
        self._latest_mix_input_end: dict[str, int] = {}
        self._transport: DatagramSender | None = None
        self._mix_metrics: dict[str, dict[str, object]] = {}
        self._timestamp_frames: dict[str, dict[int, set[int]]] = {}
        self._participant_levels: dict[str, dict[int, tuple[float, float]]] = {}
        # Per-listener source gains keep personal volume/mute choices inside that listener's
        # server-produced mix-minus. They never alter the source heard by anyone else.
        self._recipient_source_gains: dict[tuple[str, int, int], float] = {}
        self._level_push: dict[str, object] = {"listener": None, "last": {}, "published": {}}

    def set_level_listener(
        self, listener: Callable[[str, dict[str, float]], None] | None
    ) -> None:
        """Publishes compact, rate-limited meter updates outside the HTTP request path."""
        with self._lock:
            self._level_push["listener"] = listener

    def _publish_levels_locked(self, room_id: str, now: float) -> None:
        listener = self._level_push["listener"]
        last = self._level_push["last"]
        published = self._level_push["published"]
        if not callable(listener) or not isinstance(last, dict) or not isinstance(published, dict):
            return
        if now - float(last.get(room_id, 0.0)) < 0.1:
            return
        levels = {
            participant: round(value, 3)
            for participant, value in self._participant_levels_locked(room_id).items()
        }
        if levels != published.get(room_id):
            published[room_id] = levels
            listener(room_id, levels)
        last[room_id] = now

    def set_room_playout_delay(
        self,
        room_id: str,
        milliseconds: float | None,
        *,
        return_reserve_ms: float = ROOM_TIMING.return_requirement.fallback_ms,
    ) -> None:
        """
        Use the room's fixed deadline for every musical position, not packet arrival order. Each
        position closes `return_reserve_ms` before its deadline: the room timing policy's measured
        return route of its slowest live listener.
        """
        with self._lock:
            seconds = None if milliseconds is None else max(0.0, milliseconds / 1_000.0)
            reserve = max(0.0, return_reserve_ms / 1_000.0)
            # A new pre-song timing publication starts a fresh synchronization grace even when
            # the rounded deadline value happens to be unchanged.
            if (
                self._room_playout_delay_seconds.get(room_id) == seconds
                and self._room_return_reserve_seconds.get(room_id) == reserve
            ):
                return
            if seconds is None:
                self._room_playout_delay_seconds.pop(room_id, None)
                self._room_return_reserve_seconds.pop(room_id, None)
            else:
                self._room_playout_delay_seconds[room_id] = seconds
                self._room_return_reserve_seconds[room_id] = reserve
            self._reset_room_mix_locked(room_id)
            if self._control_command is not None:
                self._control_command(
                    f"DEADLINE\t{room_id}\t{0.0 if milliseconds is None else max(0.0, milliseconds)}"
                    f"\t{max(0.0, return_reserve_ms)}"
                )

    def _reset_room_mix_locked(self, room_id: str) -> None:
        """Forgets every pending and mixed position of a room whose deadline changed."""
        self._pending_mix.pop(room_id, None)
        self._pending_mix_started.pop(room_id, None)
        self._pending_mix_arrived.pop(room_id, None)
        self._mixed_positions.pop(room_id, None)
        self._mix_metrics.pop(room_id, None)
        self._excluded_mixers.pop(room_id, None)
        self._voice_started.pop(room_id, None)
        for key in [key for key in self._voice_activation_position if key[0] == room_id]:
            self._voice_activation_position.pop(key, None)
        self._seen_pcm_positions.pop(room_id, None)
        self._seen_pcm_arrivals.pop(room_id, None)
        self._timestamp_frames.pop(room_id, None)
        for key in [key for key in self._miss_history if key[0] == room_id]:
            self._miss_history.pop(key, None)
        for key in [key for key in self._deadline_misses if key[0] == room_id]:
            self._deadline_misses.pop(key, None)
            self._miss_started_at.pop(key, None)
            self._miss_started_at.pop(key, None)
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
            self._mix_metrics.pop(room_id, None)
            self._excluded_mixers.pop(room_id, None)
            self._voice_started.pop(room_id, None)
            for key in [key for key in self._voice_activation_position if key[0] == room_id]:
                self._voice_activation_position.pop(key, None)
            self._seen_pcm_positions.pop(room_id, None)
            self._seen_pcm_arrivals.pop(room_id, None)
            self._timestamp_frames.pop(room_id, None)
            for key in [key for key in self._miss_history if key[0] == room_id]:
                self._miss_history.pop(key, None)
            for key in [key for key in self._deadline_misses if key[0] == room_id]:
                self._deadline_misses.pop(key, None)
                self._miss_started_at.pop(key, None)
            for key in [key for key in self._recovery_packets if key[0] == room_id]:
                self._recovery_packets.pop(key, None)
                self._recovery_next_frame.pop(key, None)
            if self._control_command is not None:
                participants = [] if participant_ids is None else sorted(participant_ids)
                self._control_command("\t".join(("ELIGIBLE", room_id, *participants)))

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
            if self._control_command is not None:
                self._control_command(f"EXPECT\t{room_id}\t{participant_id}\t{token}")
            return token

    def set_recipient_source_gain(
        self,
        room_id: str,
        recipient_id: str,
        token: int,
        source_id: str,
        gain: float,
    ) -> bool:
        """Personalizes one source only in one authenticated listener's mix-minus."""
        with self._lock:
            recipient_key = participant_key(recipient_id)
            source_key = participant_key(source_id)
            if self._token_identity.get(token) != (room_id, recipient_key):
                return False
            # The room API has already verified that the source belongs to this room. Allow the
            # listener to set the preference before that source's UDP voice session is registered;
            # the stable participant key will apply it as soon as packets start arriving.
            if source_key == recipient_key:
                return False
            key = (room_id, recipient_key, source_key)
            bounded = max(0.0, min(2.0, float(gain)))
            if bounded == 1.0:
                self._recipient_source_gains.pop(key, None)
            else:
                self._recipient_source_gains[key] = bounded
            if self._control_command is not None:
                self._control_command(
                    f"GAIN\t{room_id}\t{recipient_id}\t{source_id}\t{bounded}"
                )
            return True

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

    def mix_metrics(self, room_id: str) -> dict[str, object]:
        with self._lock:
            metrics = dict(self._mix_metrics.get(room_id, {}))
            metrics["participant_levels"] = self._participant_levels_locked(room_id)
            metrics["excluded_mixers"] = len(self._excluded_mixers.get(room_id, set()))
            lifecycle = metrics.get("pending_lifecycle")
            if isinstance(lifecycle, dict):
                lifecycle["pending_at_end"] = len(self._pending_mix.get(room_id, {}))
            energy = metrics.get("energy_trace")
            if isinstance(energy, dict):
                metrics["energy_trace"] = {
                    stage: {
                        **values,
                        "rms": (values["sum_squares"] / max(1, values["samples"])) ** 0.5 / 32768.0,
                        "rms_nonzero": (values["nonzero_sum_squares"] / max(1, values["nonzero_samples"])) ** 0.5 / 32768.0,
                        "peak": values["peak"] / 32768.0,
                    }
                    for stage, values in energy.items()
                }
            frame_sets = self._timestamp_frames.get(room_id, {})
            mismatches = {str(timestamp): sorted(frames) for timestamp, frames in frame_sets.items() if len(frames) > 1}
            metrics["same_timestamp_different_frames"] = len(mismatches)
            metrics["same_timestamp_different_frames_examples"] = dict(list(mismatches.items())[:20])
            metrics["retained_seen_positions"] = len(self._seen_pcm_positions.get(room_id, {}))
            metrics["retained_seen_arrivals"] = len(self._seen_pcm_arrivals.get(room_id, {}))
            metrics["retained_timestamp_frames"] = len(frame_sets)
            return metrics

    def participant_levels(self, room_id: str) -> dict[str, float]:
        """Return each singer's latest microphone RMS for room-card indicators."""
        if self._native_participant_levels is not None:
            return self._native_participant_levels(room_id)
        with self._lock:
            return self._participant_levels_locked(room_id)

    def recipient_send_metrics(self, room_id: str, participant_id: str) -> dict[str, int | float]:
        if self._recipient_metrics is not None:
            native = self._recipient_metrics(room_id, participant_id)
            return {
                "packets": int(native.get("packets", 0)),
                "latest_gap_ms": float(native.get("latest_gap_ms", 0.0)),
                "maximum_gap_ms": float(native.get("maximum_gap_ms", 0.0)),
                "stalls": int(native.get("stalls", 0)),
                "last_send_monotonic_ms": float(native.get("last_send_monotonic_ms", 0.0)),
                "pipeline_position": int(native.get("pipeline_position", 0)),
                "pipeline_generation": int(native.get("pipeline_generation", 0)),
                "complete_positions": int(native.get("complete_positions", 0)),
                "partial_positions": int(native.get("partial_positions", 0)),
                "missing_contributions": int(native.get("missing_contributions", 0)),
                "ingress_nonzero_packets": int(native.get("ingress_nonzero_packets", 0)),
                "ingress_peak": int(native.get("ingress_peak", 0)),
                "recipient_nonzero_packets": int(native.get("recipient_nonzero_packets", 0)),
                "recipient_peak": int(native.get("recipient_peak", 0)),
                **{key: float(native.get(key, 0.0)) for key in _SLACK_KEYS},
                "pipeline_position_wait_ms": 0.0,
                "pipeline_mix_build_ms": 0.0,
                "pipeline_sendto_ms": 0.0,
                "pipeline_ingress_gap_latest_ms": 0.0,
                "pipeline_ingress_gap_maximum_ms": 0.0,
                **{f"gap_{reason}": 0 for reason in _PIPELINE_GAP_REASONS},
            }
        with self._lock:
            room_metrics = self._mix_metrics.get(room_id, {})
            trace = room_metrics.get("recipient_send_trace", {})
            values = trace.get(participant_id, {}) if isinstance(trace, dict) else {}
            pipeline_trace = room_metrics.get("pipeline_gap_trace", [])
            pipeline = next(
                (
                    event
                    for event in reversed(pipeline_trace)
                    if isinstance(event, dict) and event.get("recipient") == participant_id
                ),
                {},
            ) if isinstance(pipeline_trace, list) else {}
            ingress = pipeline.get("ingress", {}) if isinstance(pipeline, dict) else {}
            ingress_values = (
                [item for item in ingress.values() if isinstance(item, dict)]
                if isinstance(ingress, dict) else []
            )
            classifications = room_metrics.get("pipeline_gap_classifications", {})
            return {
                "packets": int(values.get("packets", 0)),
                "latest_gap_ms": float(values.get("latest_gap_ms", 0.0)),
                "maximum_gap_ms": float(values.get("maximum_gap_ms", 0.0)),
                "stalls": int(values.get("stalls", 0)),
                "last_send_monotonic_ms": float(values.get("last_send_monotonic_ms", 0.0)),
                "pipeline_position": int(pipeline.get("position", 0)),
                "pipeline_generation": int(pipeline.get("generation", 0)),
                "complete_positions": int(room_metrics.get("complete_positions", 0)),
                "partial_positions": int(room_metrics.get("partial_positions", 0)),
                "missing_contributions": int(
                    room_metrics.get("participant_trace", {})
                    .get(participant_id, {})
                    .get("missing_positions", 0)
                ),
                "ingress_nonzero_packets": int(
                    room_metrics.get("participant_trace", {})
                    .get(participant_id, {})
                    .get("ingress_nonzero_packets", 0)
                ),
                "ingress_peak": int(
                    room_metrics.get("energy_trace", {}).get("ingress", {}).get("peak", 0)
                ),
                "recipient_nonzero_packets": int(
                    room_metrics.get("participant_trace", {})
                    .get(participant_id, {})
                    .get("recipient_nonzero_packets", 0)
                ),
                "recipient_peak": int(
                    room_metrics.get("energy_trace", {}).get("recipient_mix", {}).get("peak", 0)
                ),
                **_slack_summary(
                    float(sample["slack_ms"])
                    for sample in room_metrics.get("collection_slack_samples", [])
                    if isinstance(sample, dict) and sample.get("participant") == participant_id
                ),
                "pipeline_position_wait_ms": float(pipeline.get("position_wait_ms", 0.0)),
                "pipeline_mix_build_ms": float(pipeline.get("mix_build_ms", 0.0)),
                "pipeline_sendto_ms": float(pipeline.get("sendto_ms", 0.0)),
                "pipeline_ingress_gap_latest_ms": max(
                    (float(item.get("latest_gap_ms", 0.0)) for item in ingress_values),
                    default=0.0,
                ),
                "pipeline_ingress_gap_maximum_ms": max(
                    (float(item.get("maximum_gap_ms", 0.0)) for item in ingress_values),
                    default=0.0,
                ),
                **{
                    f"gap_{reason}": int(classifications.get(reason, 0))
                    if isinstance(classifications, dict) else 0
                    for reason in _PIPELINE_GAP_REASONS
                },
            }

    @staticmethod
    def _classify_pipeline_gap(
        *, gap: float, generation_changed: bool, ingress_gap_ms: float,
        position_wait_ms: float, mix_build_ms: float, sendto_ms: float,
    ) -> str:
        if gap <= _PIPELINE_GAP_CLASSIFICATION_SECONDS:
            return "BELOW_ANALYSIS_THRESHOLD"
        if generation_changed:
            return "SEEK_LIFECYCLE_STALL"
        stages = (
            (sendto_ms, "SENDTO_STALL"),
            (mix_build_ms, "MIX_BUILD_STALL"),
            (position_wait_ms, "POSITION_COLLECTION_STALL"),
            (ingress_gap_ms, "NETWORK_OR_INGRESS_STALL"),
        )
        for duration_ms, reason in stages:
            if duration_ms > _PIPELINE_GAP_CLASSIFICATION_SECONDS * 1_000.0:
                return reason
        return "SERVER_EVENT_LOOP_STALL"

    def _participant_levels_locked(self, room_id: str) -> dict[str, float]:
        now = self._now()
        return {
            self._key_participant.get(key, str(key)): level
            if now - measured_at <= _PARTICIPANT_LEVEL_STALE_SECONDS else 0.0
            for key, (level, measured_at) in self._participant_levels.get(room_id, {}).items()
        }

    @staticmethod
    def _record_energy(metrics: dict[str, object], stage: str, samples: tuple[int, ...]) -> None:
        energy = metrics.setdefault("energy_trace", {})
        if not isinstance(energy, dict):
            return
        values = energy.setdefault(stage, {"packets": 0, "nonzero_packets": 0, "samples": 0, "nonzero_samples": 0, "sum_squares": 0.0, "nonzero_sum_squares": 0.0, "peak": 0})
        if not isinstance(values, dict):
            return
        if values["packets"] >= _ENERGY_TRACE_PACKET_LIMIT:
            return
        sum_squares = 0
        nonzero_samples = 0
        nonzero_sum_squares = 0
        peak = 0
        for sample in samples:
            square = sample * sample
            sum_squares += square
            peak = max(peak, abs(sample))
            if sample:
                nonzero_samples += 1
                nonzero_sum_squares += square
        values["packets"] += 1
        values["nonzero_packets"] += int(nonzero_samples > 0)
        values["samples"] += len(samples)
        values["sum_squares"] += sum_squares
        values["nonzero_samples"] += nonzero_samples
        values["nonzero_sum_squares"] += nonzero_sum_squares
        values["peak"] = max(values["peak"], peak)

    @staticmethod
    def _participant_metrics(metrics: dict[str, object], participant: str) -> dict[str, int]:
        trace = metrics.setdefault("participant_trace", {})
        if not isinstance(trace, dict):
            return {}
        return trace.setdefault(participant, {
            "ingress_packets": 0,
            "ingress_nonzero_packets": 0,
            "assigned_positions": 0,
            "mixed_positions": 0,
            "mixed_nonzero_positions": 0,
            "recipient_packets": 0,
            "recipient_nonzero_packets": 0,
        })

    def forget(self, participant_id: str) -> None:
        with self._lock:
            key = participant_key(participant_id)
            token = self._key_token.pop(key, None)
            if token is not None:
                self._token_identity.pop(token, None)
            room_id = self._key_room.pop(key, None)
            self._key_participant.pop(key, None)
            if room_id is not None:
                if self._control_command is not None:
                    self._control_command(f"FORGET\t{participant_id}")
                members = self._rooms.get(room_id, {})
                members.pop(key, None)
                self._deadline_misses.pop((room_id, key), None)
                self._miss_started_at.pop((room_id, key), None)
                self._recovery_packets.pop((room_id, key), None)
                self._recovery_next_frame.pop((room_id, key), None)
                self._voice_started.get(room_id, set()).discard(key)
                self._voice_activation_position.pop((room_id, key), None)
                self._miss_history.pop((room_id, key), None)
                self._participant_levels.get(room_id, {}).pop(key, None)
                for gain_key in [item for item in self._recipient_source_gains if item[0] == room_id and key in item[1:]]:
                    self._recipient_source_gains.pop(gain_key, None)
                if not members:
                    self._rooms.pop(room_id, None)
                    self._pending_mix.pop(room_id, None)
                    self._pending_mix_started.pop(room_id, None)
                    self._pending_mix_arrived.pop(room_id, None)
                    self._mixed_positions.pop(room_id, None)
                    self._excluded_mixers.pop(room_id, None)
                    self._voice_started.pop(room_id, None)
                    self._seen_pcm_positions.pop(room_id, None)
                    self._seen_pcm_arrivals.pop(room_id, None)
                    self._mix_metrics.pop(room_id, None)
                    self._timestamp_frames.pop(room_id, None)
                    self._participant_levels.pop(room_id, None)
                    self._latest_mix_input_end.pop(room_id, None)
                    self._mix_epochs.pop(room_id, None)
                    for gain_key in [item for item in self._recipient_source_gains if item[0] == room_id]:
                        self._recipient_source_gains.pop(gain_key, None)
                    for mapping in (
                        self._voice_activation_position,
                        self._deadline_misses,
                        self._miss_started_at,
                        self._recovery_packets,
                        self._recovery_next_frame,
                        self._miss_history,
                        self._mix_sequences,
                    ):
                        for mapping_key in [item for item in mapping if item[0] == room_id]:
                            mapping.pop(mapping_key, None)

    def connection_made(self, transport: DatagramSender) -> None:
        self._transport = transport

    def datagram_received(
        self,
        data: bytes,
        address: tuple[str, int],
        *,
        arrival_now: float | None = None,
        defer_flush: bool = False,
    ) -> None:
        with self._lock:
            self._route(data, address, arrival_now=arrival_now, defer_flush=defer_flush)

    def flush_due(self) -> None:
        """Publish positions whose fixed collection deadline expired without every singer."""
        with self._lock:
            self._flush_due_locked(self._now())

    def _route(
        self,
        data: bytes,
        address: tuple[str, int],
        *,
        arrival_now: float | None = None,
        defer_flush: bool = False,
    ) -> None:
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
        now = self._now() if arrival_now is None else arrival_now
        previous = members.get(key)
        members[key] = _Member(
            address,
            now,
            previous.last_probe_echo if previous is not None else now,
        )
        parsed = self._parse_pcm_position(data, self._wall_now())
        if parsed is not None:
            started = self._voice_started.setdefault(room_id, set())
            level = math.sqrt(sum(sample * sample for sample in parsed.samples) / max(1, len(parsed.samples))) / 32768.0
            self._participant_levels.setdefault(room_id, {})[key] = (min(1.0, level), now)
            self._publish_levels_locked(room_id, now)
            if key not in started:
                started.add(key)
                self._voice_activation_position[(room_id, key)] = parsed.timestamp & ~_SHARED_TIMELINE_FLAG

        parsed_position = None
        if parsed is not None:
            media_start = parsed.timestamp & ~_SHARED_TIMELINE_FLAG
            parsed_position = (media_start // parsed.frames * parsed.frames | _SHARED_TIMELINE_FLAG, parsed.frames)
        deadlines = self._pending_mix_started.get(room_id, {})
        defer_position = (
            parsed_position
            if parsed_position is not None
            and now <= deadlines.get(parsed_position, float("-inf"))
            else None
        )
        if not defer_flush:
            self._flush_due_locked(now, defer_position=defer_position)
        mixed_pcm = self._mix_pcm_position(room_id, key, data, arrival_now=now)
        if not defer_flush:
            self._flush_due_locked(now)
        if parsed is not None:
            metrics = self._mix_metrics.get(room_id)
            if metrics is not None:
                activation = metrics.setdefault("activation_positions", {})
                if isinstance(activation, dict):
                    participant_name = self._key_participant.get(key, str(key))
                    activation.setdefault(participant_name, parsed.timestamp & ~_SHARED_TIMELINE_FLAG)
                    expected = self._expected_mixers(room_id)
                    if expected and expected.issubset(self._voice_started.get(room_id, set())):
                        activation["all_active_from_position"] = max(
                            activation.get(name, 0)
                            for name in activation
                            if name != "all_active_from_position"
                        )
        if mixed_pcm:
            member = members[key]
            if self._transport is not None and now - member.last_probe_echo >= 1.0:
                self._transport.sendto(data, member.address)
                member.last_probe_echo = now
            return
        self._forward(room_id, key, data)

    def _mix_pcm_position(
        self,
        room_id: str,
        sender_key: int,
        data: bytes,
        *,
        arrival_now: float | None = None,
    ) -> bool:
        """Mix one shared-timeline PCM position once every expected singer has supplied it."""
        arrival_now = self._now() if arrival_now is None else arrival_now
        packet = self._parse_pcm_position(data, self._wall_now())
        if packet is None:
            return False
        metrics = self._mix_metrics.setdefault(room_id, {
            "ingress_packets": 0,
            "ingress_nonzero_packets": 0,
            "positions": 0,
            "inputs": 0,
            "nonzero_inputs": 0,
            "recipient_packets": 0,
            "nonzero_recipient_packets": 0,
            "logical_recipient_packets": 0,
            "logical_nonzero_recipient_packets": 0,
            "positions_seen": 0,
            "complete_positions": 0,
            "partial_positions": 0,
            "max_inputs_seen": 0,
            "min_expected_mixers": None,
            "max_expected_mixers": 0,
            "position_trace": [],
            "ingress_trace": [],
            "exclusion_trace": [],
            "position_lifecycle": [],
            "overlap_histogram": {},
            "partial_reason_counts": {},
            "collection_slack_samples": [],
            "energy_trace": {},
            "participant_trace": {},
            "pending_lifecycle": {
                "created_positions": 0, "complete_nonempty_positions": 0,
                "mixed_positions": 0, "closed_partial_positions": 0,
                "closed_empty_positions": 0, "late_dropped_positions": 0,
                "excluded_positions": 0, "drained_positions": 0,
                "pending_at_end": 0, "first_unmixed_positions": [],
            },
        })
        metrics["ingress_packets"] += 1
        if any(packet.samples):
            metrics["ingress_nonzero_packets"] += 1
        self._record_energy(metrics, "ingress", packet.samples)
        participant_name = self._key_participant.get(sender_key, str(sender_key))
        participant_metrics = self._participant_metrics(metrics, participant_name)
        self._record_ingress_cadence(
            metrics,
            participant_name,
            arrival_now,
            packet.timestamp & ~_SHARED_TIMELINE_FLAG,
        )
        participant_metrics["ingress_packets"] += 1
        participant_metrics["ingress_nonzero_packets"] += int(any(packet.samples))
        media_timestamp = packet.timestamp & ~_SHARED_TIMELINE_FLAG
        bin_start = media_timestamp // packet.frames * packet.frames
        absolute_close = self._absolute_collection_close_wall(room_id, bin_start)
        if absolute_close is not None and self._wall_now() > absolute_close:
            # After a relay-thread/VM scheduling pause the kernel can contain a backlog of valid
            # but obsolete datagrams.  Creating positions for that backlog emits an old burst and
            # keeps the relay behind real time, so clients correctly late-cut hundreds of packets.
            # A missed musical deadline is final: discard it here and catch up to the current grid.
            lifecycle = metrics.setdefault("pending_lifecycle", {})
            lifecycle["stale_ingress_positions"] = (
                lifecycle.get("stale_ingress_positions", 0) + 1
            )
            return True
        ingress_trace = metrics["ingress_trace"]
        if len(ingress_trace) < 5_000:
            ingress_trace.append({
                "participant": self._key_participant.get(sender_key, str(sender_key)),
                "timestamp": media_timestamp,
                "bin_start": media_timestamp // packet.frames * packet.frames,
                "frames": packet.frames,
                "nonzero": any(packet.samples),
                "arrival_now": arrival_now,
            })
        self._prepare_mix_timeline(room_id, packet)
        timestamp_frames = self._timestamp_frames.setdefault(room_id, {})
        timestamp_frames.setdefault(packet.timestamp & ~_SHARED_TIMELINE_FLAG, set()).add(packet.frames)
        self._advance_recovery(
            room_id,
            sender_key,
            packet.timestamp,
            packet.frames,
            packet.ingress_lateness_frames,
        )
        touched = self._store_pcm_segments(room_id, sender_key, packet)
        slack_samples = metrics["collection_slack_samples"]
        for position in touched:
            participant_metrics["assigned_positions"] += 1
            deadline = self._pending_mix_started.get(room_id, {}).get(position)
            if deadline is not None and len(slack_samples) < 5_000:
                slack_samples.append({
                    "participant": self._key_participant.get(sender_key, str(sender_key)),
                    "position": position[0] & ~_SHARED_TIMELINE_FLAG,
                    "arrival_now": arrival_now,
                    "deadline_now": deadline,
                    "slack_ms": (deadline - arrival_now) * 1_000.0,
                    "after_close": arrival_now > deadline,
                })
        for position in touched:
            inputs = self._pending_mix.get(room_id, {}).get(position)
            if inputs is not None and self._inputs_complete(room_id, inputs):
                for key in self._expected_mixers(room_id):
                    self._deadline_misses.pop((room_id, key), None)
                    self._miss_history.pop((room_id, key), None)
                    self._miss_started_at.pop((room_id, key), None)
                self._finish_mix_position(room_id, position, inputs)
        return True

    def _absolute_collection_close_wall(self, room_id: str, bin_start: int) -> float | None:
        delay = self._room_playout_delay_seconds.get(room_id)
        if delay is None:
            return None
        return bin_start / VOICE_SAMPLE_RATE_HZ + max(0.0, delay - self._return_reserve(room_id))

    @staticmethod
    def _record_ingress_cadence(
        metrics: dict[str, object], participant: str, arrived_at: float, position: int
    ) -> None:
        trace = metrics.setdefault("ingress_cadence", {})
        if not isinstance(trace, dict):
            return
        values = trace.setdefault(participant, {
            "packets": 0, "latest_gap_ms": 0.0, "maximum_gap_ms": 0.0,
            "last_ingress_monotonic_ms": 0.0, "last_position": 0,
        })
        previous = float(values["last_ingress_monotonic_ms"]) / 1_000.0
        gap_ms = 0.0 if previous == 0.0 else round((arrived_at - previous) * 1_000.0, 3)
        values["packets"] = int(values["packets"]) + 1
        values["latest_gap_ms"] = gap_ms
        values["maximum_gap_ms"] = max(float(values["maximum_gap_ms"]), gap_ms)
        values["last_ingress_monotonic_ms"] = round(arrived_at * 1_000.0, 3)
        values["last_position"] = position

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
            self._seen_pcm_positions.pop(room_id, None)
            self._seen_pcm_arrivals.pop(room_id, None)
            self._timestamp_frames.pop(room_id, None)
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
        arrival_frame = max(0, round(wall_now * VOICE_SAMPLE_RATE_HZ))
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
        lifecycle = self._mix_metrics.setdefault(room_id, {}).setdefault("position_lifecycle", [])
        pending_positions = self._pending_mix.setdefault(room_id, {})
        pending = pending_positions.get(position)
        pending_found = pending is not None
        pending_closed = position in self._mixed_positions.setdefault(room_id, set())
        expected = sender_key in self._expected_mixers(room_id)
        inputs_before = [] if pending is None else sorted(
            self._key_participant.get(key, str(key)) for key in pending
        )
        event = {
            "position": position[0] & ~_SHARED_TIMELINE_FLAG,
            "frames": position[1],
            "participant": self._key_participant.get(sender_key, str(sender_key)),
            "pending_found": pending_found,
            "pending_closed": pending_closed,
            "participant_expected": expected,
            "insert_attempted": False,
            "inserted": False,
            "inputs_before": inputs_before,
            "inputs_after": inputs_before,
            "packet_timestamp": packet.timestamp & ~_SHARED_TIMELINE_FLAG,
            "packet_frames": packet.frames,
            "arrival_monotonic": self._now(),
        }
        if isinstance(lifecycle, list) and len(lifecycle) < 5_000:
            lifecycle.append(event)
        if position in self._mixed_positions.setdefault(room_id, set()):
            lifecycle = self._mix_metrics.setdefault(room_id, {}).setdefault("pending_lifecycle", {})
            lifecycle["late_dropped_positions"] = lifecycle.get("late_dropped_positions", 0) + 1
            return  # an expired/duplicate sample is never emitted on a later beat
        self._seen_pcm_positions.setdefault(room_id, {}).setdefault(position, set()).add(sender_key)
        self._seen_pcm_arrivals.setdefault(room_id, {}).setdefault(position, {})[sender_key] = self._now()
        bin_start, frames = position[0] & ~_SHARED_TIMELINE_FLAG, position[1]
        media_start = packet.timestamp & ~_SHARED_TIMELINE_FLAG
        overlap_start = max(bin_start, media_start)
        overlap_end = min(bin_start + frames, media_start + packet.frames)
        event["overlap_start"] = overlap_start - bin_start
        event["overlap_end"] = overlap_end - bin_start
        histogram = self._mix_metrics.setdefault(room_id, {}).setdefault("overlap_histogram", {})
        if overlap_end > overlap_start and isinstance(histogram, dict):
            size = overlap_end - overlap_start
            histogram[str(size)] = histogram.get(str(size), 0) + 1
        if overlap_start >= overlap_end:
            event["insert_attempted"] = True
            return
        event["insert_attempted"] = True
        inputs = self._pending_mix.setdefault(room_id, {}).setdefault(position, {})
        if not inputs:
            lifecycle = self._mix_metrics.setdefault(room_id, {}).setdefault("pending_lifecycle", {})
            lifecycle["created_positions"] = lifecycle.get("created_positions", 0) + 1
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
        event["inserted"] = True
        event["inputs_after"] = sorted(
            self._key_participant.get(key, str(key)) for key in inputs
        )
        started = self._now()
        absolute_close = self._absolute_collection_close_wall(room_id, bin_start)
        if absolute_close is None:
            deadline = started + _MIX_COLLECTION_SECONDS
        else:
            # Packet timestamps use the server's wall-clock musical epoch; scheduling uses
            # monotonic time. Comparing them directly left an incomplete position pending forever.
            # A late singer may consume its own position, but must not hold an already available
            # singer until the room's return budget has also expired.  The absolute musical
            # deadline remains the outer bound; the fixed collection span keeps timeliness ahead
            # of completeness inside that bound.
            deadline = min(
                started + _MIX_COLLECTION_SECONDS,
                started + max(0.0, absolute_close - self._wall_now()),
            )
        self._pending_mix_started.setdefault(room_id, {}).setdefault(position, deadline)
        self._pending_mix_arrived.setdefault(room_id, {}).setdefault(position, started)

    def _inputs_complete(self, room_id: str, inputs: dict[int, _PendingPcm]) -> bool:
        expected = self._expected_mixers(room_id)
        return expected.issubset(inputs) and all(inputs[key].complete() for key in expected)

    def _return_reserve(self, room_id: str) -> float:
        return self._room_return_reserve_seconds.get(
            room_id, ROOM_TIMING.return_requirement.fallback_ms / 1_000.0
        )

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
            else round(max(0.0, delay - self._return_reserve(room_id)) * VOICE_SAMPLE_RATE_HZ)
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

    def _flush_due_locked(
        self,
        now: float,
        *,
        defer_position: tuple[int, int] | None = None,
    ) -> None:
        for room_id, positions in tuple(self._pending_mix.items()):
            deadlines = self._pending_mix_started.get(room_id, {})
            excluded = self._excluded_mixers.setdefault(room_id, set())
            for position, inputs in tuple(positions.items()):
                if position == defer_position:
                    continue
                if now < deadlines.get(position, now + _MIX_COLLECTION_SECONDS):
                    continue
                expected = {
                    key
                    for key, expected_room in self._key_room.items()
                    if expected_room == room_id and key not in excluded
                }
                started = self._voice_started.setdefault(room_id, set())
                complete = {key for key, samples in inputs.items() if samples.complete()}
                # Do not start miss accounting until every eligible singer has
                # supplied at least one valid timeline packet.  During this
                # activation barrier, early scheduling gaps are startup state,
                # not evidence that a participant is unhealthy.
                active_expected = expected if expected and expected.issubset(started) else set()
                for key in active_expected.intersection(complete):
                    self._deadline_misses.pop((room_id, key), None)
                    self._miss_history.pop((room_id, key), None)
                newly_excluded = set()
                for key in active_expected.difference(complete):
                    miss_key = (room_id, key)
                    misses = self._deadline_misses.get(miss_key, 0) + 1
                    self._deadline_misses[miss_key] = misses
                    started_at = self._miss_started_at.setdefault(miss_key, now)
                    history = self._miss_history.setdefault(miss_key, [])
                    seen = key in self._seen_pcm_positions.get(room_id, {}).get(position, set())
                    deadline = deadlines.get(position)
                    arrival = self._seen_pcm_arrivals.get(room_id, {}).get(position, {}).get(key)
                    lifecycle_events = self._mix_metrics.get(room_id, {}).get("position_lifecycle", [])
                    event = next(
                        (
                            item for item in reversed(lifecycle_events)
                            if item.get("position") == (position[0] & ~_SHARED_TIMELINE_FLAG)
                            and item.get("frames") == position[1]
                            and item.get("participant") == self._key_participant.get(key, str(key))
                        ),
                        None,
                    ) if isinstance(lifecycle_events, list) else None
                    if event is not None:
                        event["close_monotonic"] = now
                        event["close_deadline"] = deadlines.get(position)
                    coverage = {
                        self._key_participant.get(item, str(item)): samples.coverage()
                        for item, samples in inputs.items()
                    }
                    participant_name = self._key_participant.get(key, str(key))
                    fragments = [
                        item for item in lifecycle_events
                        if isinstance(item, dict)
                        and item.get("position") == (position[0] & ~_SHARED_TIMELINE_FLAG)
                        and item.get("frames") == position[1]
                        and item.get("participant") == participant_name
                    ] if isinstance(lifecycle_events, list) else []
                    classification = (
                        "ARRIVED_AFTER_CLOSE"
                        if seen and deadline is not None and arrival is not None and arrival > deadline
                        else "PENDING_ALREADY_CLOSED"
                        if event is not None and event.get("pending_closed")
                        else "PARTICIPANT_NOT_EXPECTED"
                        if event is not None and not event.get("participant_expected")
                        else "INSERT_REJECTED"
                        if event is not None and not event.get("inserted")
                        else "INSERTED_BUT_MISSING_AT_CLOSE"
                        if event is not None
                        else "NO_INGRESS"
                    )
                    history.append({
                        "position": position[0] & ~_SHARED_TIMELINE_FLAG,
                        "consecutive_misses": misses,
                        "received_ids": sorted(
                            self._key_participant.get(item, str(item)) for item in complete
                        ),
                        "classification": classification,
                        "position_lifecycle": event,
                        "coverage": coverage,
                        "fragments": fragments,
                        "late_by_ms": (
                            None
                            if classification != "ARRIVED_AFTER_CLOSE" or deadline is None or arrival is None
                            else (arrival - deadline) * 1_000.0
                        ),
                    })
                    reason_counts = self._mix_metrics.setdefault(room_id, {}).setdefault("partial_reason_counts", {})
                    reason_counts[classification] = reason_counts.get(classification, 0) + 1
                    del history[:-8]
                    if misses >= _EXCLUSION_MISSES and now - started_at >= _EXCLUSION_GRACE_SECONDS:
                        newly_excluded.add(key)
                        self._deadline_misses.pop(miss_key, None)
                excluded.update(newly_excluded)
                for key in newly_excluded:
                    lifecycle = self._mix_metrics.setdefault(room_id, {}).setdefault("pending_lifecycle", {})
                    lifecycle["excluded_positions"] = lifecycle.get("excluded_positions", 0) + 1
                    recovery_key = (room_id, key)
                    self._recovery_packets[recovery_key] = 0
                    self._recovery_next_frame.pop(recovery_key, None)
                    metrics = self._mix_metrics.setdefault(room_id, {})
                    exclusion_trace = metrics.setdefault("exclusion_trace", [])
                    if isinstance(exclusion_trace, list) and len(exclusion_trace) < 100:
                        exclusion_trace.append({
                            "participant": self._key_participant.get(key, str(key)),
                            "position": position[0] & ~_SHARED_TIMELINE_FLAG,
                            "consecutive_misses": misses,
                            "received_ids": sorted(
                                self._key_participant.get(item, str(item)) for item in complete
                            ),
                            "miss_history": list(self._miss_history.get((room_id, key), [])),
                        })
                self._finish_mix_position(room_id, position, inputs)

    def _finish_mix_position(
        self,
        room_id: str,
        position: tuple[int, int],
        inputs: dict[int, _PendingPcm],
    ) -> None:
        timestamp, frames = position
        expected = self._expected_mixers(room_id)
        metrics = self._mix_metrics.setdefault(room_id, {})
        metrics["positions_seen"] = metrics.get("positions_seen", 0) + 1
        metrics["max_inputs_seen"] = max(metrics.get("max_inputs_seen", 0), len(inputs))
        expected_count = len(expected)
        previous_min = metrics.get("min_expected_mixers")
        metrics["min_expected_mixers"] = expected_count if previous_min is None else min(previous_min, expected_count)
        metrics["max_expected_mixers"] = max(metrics.get("max_expected_mixers", 0), expected_count)
        complete = expected.issubset(inputs) and all(inputs[key].complete() for key in expected)
        lifecycle = metrics.setdefault("pending_lifecycle", {})
        if complete and expected:
            lifecycle["complete_nonempty_positions"] = lifecycle.get("complete_nonempty_positions", 0) + 1
        elif not complete and inputs:
            lifecycle["closed_partial_positions"] = lifecycle.get("closed_partial_positions", 0) + 1
        elif not inputs:
            lifecycle["closed_empty_positions"] = lifecycle.get("closed_empty_positions", 0) + 1
        key = "complete_positions" if complete else "partial_positions"
        metrics[key] = metrics.get(key, 0) + 1
        trace = metrics.setdefault("position_trace", [])
        if isinstance(trace, list) and expected and len(trace) < 100:
            deadline = self._pending_mix_started.get(room_id, {}).get(position)
            expected_ids = sorted(self._key_participant.get(key, str(key)) for key in expected)
            received_ids = sorted(self._key_participant.get(key, str(key)) for key in inputs)
            missing_ids = sorted(set(expected_ids).difference(received_ids))
            trace.append({
                "position": timestamp & ~_SHARED_TIMELINE_FLAG,
                "expected": expected_ids,
                "received": received_ids,
                "missing": missing_ids,
                "complete": complete,
                "deadline_now": deadline,
            })
        audible = {
            key: tuple(samples.samples)
            for key, samples in inputs.items()
            if key in expected and samples.complete()
        }
        if complete and expected and not audible:
            examples = lifecycle.setdefault("first_unmixed_positions", [])
            if len(examples) < 10:
                examples.append({
                    "position": timestamp & ~_SHARED_TIMELINE_FLAG,
                    "expected": sorted(self._key_participant.get(key, str(key)) for key in expected),
                    "received": sorted(self._key_participant.get(key, str(key)) for key in inputs),
                    "reason": "COMPLETE_WITHOUT_AUDIBLE_INPUT",
                })
        metrics = self._mix_metrics.setdefault(room_id, {})
        for key, voice in audible.items():
            participant_name = self._key_participant.get(key, str(key))
            participant_metrics = self._participant_metrics(metrics, participant_name)
            participant_metrics["mixed_positions"] += 1
            participant_metrics["mixed_nonzero_positions"] += int(any(voice))
        ingress = {
            key: samples.ingress_lateness_frames
            for key, samples in inputs.items()
            if key in audible
        }
        finished_at = self._now()
        arrived = self._pending_mix_arrived.get(room_id, {}).get(position, finished_at)
        mix_wait_frames = max(0, round((finished_at - arrived) * VOICE_SAMPLE_RATE_HZ))
        self._emit_mix(
            room_id, timestamp, frames, audible, ingress, mix_wait_frames,
            {
                "position": timestamp & ~_SHARED_TIMELINE_FLAG,
                "generation": self._mix_epochs.get(room_id, 1),
                "created_monotonic": arrived,
                "finished_monotonic": finished_at,
                "complete": complete,
            },
        )
        pending = self._pending_mix.get(room_id, {})
        pending.pop(position, None)
        self._pending_mix_started.get(room_id, {}).pop(position, None)
        self._pending_mix_arrived.get(room_id, {}).pop(position, None)
        self._seen_pcm_positions.get(room_id, {}).pop(position, None)
        self._seen_pcm_arrivals.get(room_id, {}).pop(position, None)
        media_timestamp = timestamp & ~_SHARED_TIMELINE_FLAG
        if not any(
            candidate_timestamp & ~_SHARED_TIMELINE_FLAG == media_timestamp
            for candidate_timestamp, _candidate_frames in pending
        ):
            self._timestamp_frames.get(room_id, {}).pop(media_timestamp, None)
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
        pipeline: dict[str, object],
    ) -> None:
        if self._transport is None:
            return
        members = self._rooms.get(room_id, {})
        metrics = self._mix_metrics.setdefault(room_id, {
            "ingress_packets": 0,
            "ingress_nonzero_packets": 0,
            "positions": 0,
            "inputs": 0,
            "nonzero_inputs": 0,
            "recipient_packets": 0,
            "nonzero_recipient_packets": 0,
            "logical_recipient_packets": 0,
            "logical_nonzero_recipient_packets": 0,
            "positions_seen": 0,
            "complete_positions": 0,
            "partial_positions": 0,
            "max_inputs_seen": 0,
            "min_expected_mixers": None,
            "max_expected_mixers": 0,
            "position_trace": [],
            "ingress_trace": [],
            "exclusion_trace": [],
            "collection_slack_samples": [],
            "energy_trace": {},
            "participant_trace": {},
            "pending_lifecycle": {
                "created_positions": 0, "complete_nonempty_positions": 0,
                "mixed_positions": 0, "closed_partial_positions": 0,
                "closed_empty_positions": 0, "late_dropped_positions": 0,
                "excluded_positions": 0, "drained_positions": 0,
                "pending_at_end": 0, "first_unmixed_positions": [],
            },
        })
        metrics["positions"] += 1
        lifecycle = metrics.setdefault("pending_lifecycle", {})
        lifecycle["mixed_positions"] = lifecycle.get("mixed_positions", 0) + 1
        metrics["inputs"] += len(inputs)
        metrics["nonzero_inputs"] += sum(1 for voice in inputs.values() if any(voice))
        for voice in inputs.values():
            self._record_energy(metrics, "mix_inputs", voice)
        mix_key = participant_key(_SERVER_MIX_PARTICIPANT_ID)
        mix_started = self._now()
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
            self._record_energy(metrics, "recipient_mix", tuple(struct.unpack_from(f"<{frames}h", packet, _WIRE_V3.size)))
            self._record_energy(metrics, "recipient_send", tuple(struct.unpack_from(f"<{frames}h", packet, _WIRE_V3.size)))
            for source_key, voice in inputs.items():
                if source_key == recipient_key:
                    continue
                source_name = self._key_participant.get(source_key, str(source_key))
                source_metrics = self._participant_metrics(metrics, source_name)
                source_metrics["recipient_packets"] += 1
                source_metrics["recipient_nonzero_packets"] += int(any(voice))
            if any(packet[_WIRE_V3.size:]):
                metrics["nonzero_recipient_packets"] += 1
                metrics["logical_nonzero_recipient_packets"] += 1
            metrics["logical_recipient_packets"] += 1
            send_started = self._now()
            sent_at = send_started
            send_trace = metrics.setdefault("recipient_send_trace", {})
            recipient = self._key_participant.get(recipient_key, str(recipient_key))
            cadence = send_trace.setdefault(
                recipient,
                {
                    "packets": 0,
                    "latest_gap_ms": 0.0,
                    "maximum_gap_ms": 0.0,
                    "stalls": 0,
                    "last_send_monotonic_ms": 0.0,
                },
            )
            previous = float(cadence["last_send_monotonic_ms"]) / 1_000.0
            recipient_generations = metrics.setdefault("recipient_send_generation", {})
            previous_generation = (
                int(recipient_generations.get(recipient, 0))
                if isinstance(recipient_generations, dict) else 0
            )
            current_generation = int(pipeline["generation"])
            if isinstance(recipient_generations, dict):
                recipient_generations[recipient] = current_generation
            gap = 0.0 if previous == 0.0 else sent_at - previous
            gap_ms = round(gap * 1_000.0, 3)
            cadence["packets"] = int(cadence["packets"]) + 1
            cadence["latest_gap_ms"] = gap_ms
            cadence["maximum_gap_ms"] = max(float(cadence["maximum_gap_ms"]), gap_ms)
            cadence["stalls"] = int(cadence["stalls"]) + int(
                previous != 0.0 and gap > _RECIPIENT_SEND_STALL_SECONDS
            )
            # The room mix is PCM over UDP, so losing one datagram would otherwise insert
            # 2.5 ms of silence at this exact musical position. Identical copies keep the same
            # sequence/timestamp; AudioService accepts the first and discards the duplicate.
            for _ in range(self._mix_packet_copies):
                self._transport.sendto(packet, member.address)
                metrics["recipient_packets"] += 1
            send_finished = self._now()
            cadence["last_send_monotonic_ms"] = round(sent_at * 1_000.0, 3)
            if previous != 0.0 and gap > _RECIPIENT_SEND_STALL_SECONDS:
                gap_trace = metrics.setdefault("pipeline_gap_trace", [])
                if isinstance(gap_trace, list):
                    ingress_trace = metrics.get("ingress_cadence", {})
                    ingress_values = (
                        [item for item in ingress_trace.values() if isinstance(item, dict)]
                        if isinstance(ingress_trace, dict) else []
                    )
                    ingress_gap_ms = max(
                        (float(item.get("latest_gap_ms", 0.0)) for item in ingress_values),
                        default=0.0,
                    )
                    position_wait_ms = (
                        float(pipeline["finished_monotonic"])
                        - float(pipeline["created_monotonic"])
                    ) * 1_000.0
                    mix_build_ms = (send_started - mix_started) * 1_000.0
                    sendto_ms = (send_finished - send_started) * 1_000.0
                    classification = self._classify_pipeline_gap(
                        gap=gap,
                        generation_changed=(
                            previous_generation != 0 and previous_generation != current_generation
                        ),
                        ingress_gap_ms=ingress_gap_ms,
                        position_wait_ms=position_wait_ms,
                        mix_build_ms=mix_build_ms,
                        sendto_ms=sendto_ms,
                    )
                    gap_trace.append({
                        **pipeline,
                        "recipient": recipient,
                        "send_gap_ms": gap_ms,
                        "position_wait_ms": round(position_wait_ms, 3),
                        "mix_build_ms": round(mix_build_ms, 3),
                        "sendto_ms": round(sendto_ms, 3),
                        "classification": classification,
                        "ingress": {
                            name: dict(values) for name, values in ingress_trace.items()
                        } if isinstance(ingress_trace, dict) else {},
                    })
                    del gap_trace[:-200]
                    if classification in _PIPELINE_GAP_REASONS:
                        counts = metrics.setdefault("pipeline_gap_classifications", {})
                        if isinstance(counts, dict):
                            counts[classification] = int(counts.get(classification, 0)) + 1

    def _recipient_mix_packet(
        self, room_id: str, recipient_key: int, token: int, mix_key: int, timestamp: int,
        frames: int, inputs: dict[int, tuple[int, ...]], ingress: dict[int, int],
        mix_wait_frames: int,
    ) -> bytes:
        source_gains = {
            key: self._recipient_source_gains.get((room_id, recipient_key, key), 1.0)
            for key in inputs
            if key != recipient_key
        }
        samples = tuple(
            max(
                -32_768,
                min(
                    32_767,
                    round(sum(
                        voice[index] * source_gains[key]
                        for key, voice in inputs.items()
                        if key != recipient_key
                    )),
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
    # Do not let a continuously readable UDP socket starve musical-position deadlines. One
    # blocking receive plus this many queued datagrams is processed before due mixes are flushed.
    _MAX_QUEUED_DATAGRAMS_BEFORE_FLUSH = 16

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
            # Capture the receive timestamp before any parsing/locking work. The relay uses
            # this timestamp for the position deadline, so interpreter scheduling cannot turn
            # an already-received packet into a late packet.
            batch_now = self._relay._now()
            self._relay.datagram_received(
                data, address, arrival_now=batch_now, defer_flush=True
            )
            self._socket.setblocking(False)
            try:
                for _ in range(self._MAX_QUEUED_DATAGRAMS_BEFORE_FLUSH):
                    try:
                        queued_data, queued_address = self._socket.recvfrom(_MAXIMUM_DATAGRAM_BYTES)
                    except BlockingIOError:
                        break
                    self._relay.datagram_received(
                        queued_data,
                        queued_address,
                        arrival_now=batch_now,
                        defer_flush=True,
                    )
            finally:
                self._socket.setblocking(True)
                self._socket.settimeout(self._STOP_POLL_SECONDS)
            self._relay.flush_due()
        except OSError:
            # A send to one unreachable member must not stop the relay for everyone else.
            logger.warning("Voice relay could not forward a packet", exc_info=True)
