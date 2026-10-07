"""Sending: each listener's mix-minus of a closed position, and forwarding of non-mixed packets."""

from __future__ import annotations

from dataclasses import dataclass

from backend.infrastructure.voice_relay_metrics import (
    PIPELINE_GAP_REASONS,
    classify_pipeline_gap,
    count,
    latest_ingress_gap_ms,
    participant_metrics,
    record_energy,
)
from backend.infrastructure.voice_relay_state import Member, RelayState
from backend.infrastructure.voice_wire import (
    SERVER_MIX_PARTICIPANT_ID,
    MixHeader,
    has_audio,
    mix_packet,
    mix_samples,
    participant_key,
    readdressed,
)
from backend.room.voice_protocol import VOICE_PACKETS_PER_SECOND

_STALE_MEMBER_SECONDS = (
    30.0  # a participant who stops sending audio is dropped so relaying does not keep them
)
_RECIPIENT_SEND_STALL_SECONDS = (
    3 / VOICE_PACKETS_PER_SECOND
)  # three missing send slots form a burst


@dataclass(frozen=True, slots=True)
class MixedPosition:
    """One closed position's audible voices, ready to be mixed for every listener."""

    timestamp: int
    frames: int
    inputs: dict[int, tuple[int, ...]]
    ingress: dict[int, int]
    mix_wait_frames: int
    pipeline: dict


@dataclass(frozen=True, slots=True)
class _SendTiming:
    gap: float
    gap_ms: float
    generation_changed: bool
    mix_started: float
    send_started: float
    send_finished: float


def _mix_minus(
    mixed: MixedPosition, recipient_key: int, gains: dict[int, float]
) -> tuple[int, ...]:
    """Every voice but the recipient's own, at that recipient's gains, clipped to PCM16."""
    return tuple(
        max(
            -32_768,
            min(
                32_767,
                round(
                    sum(
                        voice[index] * gains[key]
                        for key, voice in mixed.inputs.items()
                        if key != recipient_key
                    )
                ),
            ),
        )
        for index in range(mixed.frames)
    )


class RelayEmission(RelayState):
    def _emit_mix(self, room_id: str, mixed: MixedPosition) -> None:
        if self._transport is None:
            return
        members = self._rooms.get(room_id, {})
        metrics = self._room_metrics(room_id)
        metrics["positions"] += 1
        count(metrics.setdefault("pending_lifecycle", {}), "mixed_positions")
        metrics["inputs"] += len(mixed.inputs)
        metrics["nonzero_inputs"] += sum(1 for voice in mixed.inputs.values() if any(voice))
        for voice in mixed.inputs.values():
            record_energy(metrics, "mix_inputs", voice)
        mix_key = participant_key(SERVER_MIX_PARTICIPANT_ID)
        mix_started = self._now()
        for recipient_key, member in members.items():
            token = self._session_token(room_id, recipient_key)
            if token is None:
                continue
            packet = self._recipient_mix_packet(room_id, recipient_key, token, mix_key, mixed)
            self._send_mix(room_id, recipient_key, member, packet, mixed, mix_started)

    def _send_mix(
        self,
        room_id: str,
        recipient_key: int,
        member: Member,
        packet: bytes,
        mixed: MixedPosition,
        mix_started: float,
    ) -> None:
        assert self._transport is not None
        metrics = self._room_metrics(room_id)
        self._count_recipient_packet(room_id, recipient_key, packet, mixed)
        send_started = self._now()
        recipient = self._participant_name(room_id, recipient_key)
        cadence, previous, generation_changed = self._note_send(
            metrics, recipient, send_started, int(mixed.pipeline["generation"])
        )
        # The room mix is PCM over UDP, so losing one datagram would otherwise insert
        # 2.5 ms of silence at this exact musical position. Identical copies keep the same
        # sequence/timestamp; AudioService accepts the first and discards the duplicate.
        for _ in range(self._mix_packet_copies):
            self._transport.sendto(packet, member.address)
            metrics["recipient_packets"] += 1
        send_finished = self._now()
        cadence["last_send_monotonic_ms"] = round(send_started * 1_000.0, 3)
        gap = 0.0 if previous == 0.0 else send_started - previous
        if previous != 0.0 and gap > _RECIPIENT_SEND_STALL_SECONDS:
            timing = _SendTiming(
                gap,
                round(gap * 1_000.0, 3),
                generation_changed,
                mix_started,
                send_started,
                send_finished,
            )
            self._trace_pipeline_gap(metrics, mixed.pipeline, recipient, timing)

    def _count_recipient_packet(
        self, room_id: str, recipient_key: int, packet: bytes, mixed: MixedPosition
    ) -> None:
        metrics = self._room_metrics(room_id)
        samples = mix_samples(packet, mixed.frames)
        record_energy(metrics, "recipient_mix", samples)
        record_energy(metrics, "recipient_send", samples)
        for source_key, voice in mixed.inputs.items():
            if source_key == recipient_key:
                continue
            source_metrics = participant_metrics(
                metrics, self._participant_name(room_id, source_key)
            )
            source_metrics["recipient_packets"] += 1
            source_metrics["recipient_nonzero_packets"] += int(any(voice))
        if has_audio(packet):
            metrics["nonzero_recipient_packets"] += 1
            metrics["logical_nonzero_recipient_packets"] += 1
        metrics["logical_recipient_packets"] += 1

    @staticmethod
    def _note_send(
        metrics: dict, recipient: str, sent_at: float, generation: int
    ) -> tuple[dict, float, bool]:
        """Updates a recipient's send cadence; returns it, its previous send and a generation change."""
        send_trace = metrics.setdefault("recipient_send_trace", {})
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
        generations = metrics.setdefault("recipient_send_generation", {})
        previous_generation = (
            int(generations.get(recipient, 0)) if isinstance(generations, dict) else 0
        )
        if isinstance(generations, dict):
            generations[recipient] = generation
        gap = 0.0 if previous == 0.0 else sent_at - previous
        gap_ms = round(gap * 1_000.0, 3)
        cadence["packets"] = int(cadence["packets"]) + 1
        cadence["latest_gap_ms"] = gap_ms
        cadence["maximum_gap_ms"] = max(float(cadence["maximum_gap_ms"]), gap_ms)
        cadence["stalls"] = int(cadence["stalls"]) + int(
            previous != 0.0 and gap > _RECIPIENT_SEND_STALL_SECONDS
        )
        changed = previous_generation != 0 and previous_generation != generation
        return cadence, previous, changed

    @staticmethod
    def _trace_pipeline_gap(
        metrics: dict, pipeline: dict, recipient: str, timing: _SendTiming
    ) -> None:
        gap_trace = metrics.setdefault("pipeline_gap_trace", [])
        if not isinstance(gap_trace, list):
            return
        ingress_trace = metrics.get("ingress_cadence", {})
        position_wait_ms = (
            float(pipeline["finished_monotonic"]) - float(pipeline["created_monotonic"])
        ) * 1_000.0
        mix_build_ms = (timing.send_started - timing.mix_started) * 1_000.0
        sendto_ms = (timing.send_finished - timing.send_started) * 1_000.0
        classification = classify_pipeline_gap(
            gap=timing.gap,
            generation_changed=timing.generation_changed,
            ingress_gap_ms=latest_ingress_gap_ms(ingress_trace),
            position_wait_ms=position_wait_ms,
            mix_build_ms=mix_build_ms,
            sendto_ms=sendto_ms,
        )
        gap_trace.append(
            {
                **pipeline,
                "recipient": recipient,
                "send_gap_ms": timing.gap_ms,
                "position_wait_ms": round(position_wait_ms, 3),
                "mix_build_ms": round(mix_build_ms, 3),
                "sendto_ms": round(sendto_ms, 3),
                "classification": classification,
                "ingress": {name: dict(values) for name, values in ingress_trace.items()}
                if isinstance(ingress_trace, dict)
                else {},
            }
        )
        del gap_trace[:-200]
        if classification not in PIPELINE_GAP_REASONS:
            return
        counts = metrics.setdefault("pipeline_gap_classifications", {})
        if isinstance(counts, dict):
            counts[classification] = int(counts.get(classification, 0)) + 1

    def _recipient_mix_packet(
        self, room_id: str, recipient_key: int, token: int, mix_key: int, mixed: MixedPosition
    ) -> bytes:
        source_gains = {
            key: self._recipient_source_gains.get((room_id, recipient_key, key), 1.0)
            for key in mixed.inputs
            if key != recipient_key
        }
        samples = _mix_minus(mixed, recipient_key, source_gains)
        sequence_key = (room_id, recipient_key)
        sequence = self._mix_sequences.get(sequence_key, 0)
        self._mix_sequences[sequence_key] = (sequence + 1) & 0xFFFF_FFFF
        remote_ingress_frames = max(
            (value for key, value in mixed.ingress.items() if key != recipient_key), default=0
        )
        stage_report = min(remote_ingress_frames, 0xFFFF) | (
            min(mixed.mix_wait_frames, 0xFFFF) << 16
        )
        header = MixHeader(
            sequence,
            mix_key,
            token,
            mixed.timestamp,
            mixed.frames,
            stage_report,
            self._mix_epochs.get(room_id, 1),
        )
        return mix_packet(header, samples)

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
                recipient_token = self._session_token(room_id, key)
                if recipient_token is None:
                    continue
                self._transport.sendto(readdressed(data, recipient_token), member.address)
            elif now - member.last_probe_echo >= 1.0:
                # The client recognizes its own key as an RTT probe and never mixes it as audio.
                self._transport.sendto(data, member.address)
                member.last_probe_echo = now
