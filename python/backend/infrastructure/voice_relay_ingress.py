"""Receiving: a singer's packet is authenticated, placed into its musical positions and, once a
position is complete, mixed at once instead of waiting for its deadline."""

from __future__ import annotations

import math

from backend.infrastructure.voice_pending import PendingPcm
from backend.infrastructure.voice_relay_collection import MIX_COLLECTION_SECONDS, RelayCollection
from backend.infrastructure.voice_relay_metrics import (
    count,
    participant_metrics,
    record_energy,
    record_ingress_cadence,
)
from backend.infrastructure.voice_relay_state import Member, Position
from backend.infrastructure.voice_wire import (
    SHARED_TIMELINE_FLAG,
    PcmPosition,
    media_frame,
    packet_identity,
    parse_pcm_position,
)
from backend.room.voice_protocol import VOICE_SAMPLE_RATE_HZ

_RECOVERY_PACKETS = 200  # 0.5 s at the AudioService packet rate
_TIMELINE_RESTART_FRAMES = (
    VOICE_SAMPLE_RATE_HZ  # tolerate reordering, but reset after a >1 s rewind
)
_TRACE_LIMIT = 5_000


class RelayIngress(RelayCollection):
    def _route(
        self,
        data: bytes,
        address: tuple[str, int],
        *,
        arrival_now: float | None = None,
        defer_flush: bool = False,
    ) -> None:
        identity = packet_identity(data)
        if identity is None:
            return
        session = self._token_identity.get(identity.token)
        if session is None or session[1] != identity.key:
            return
        room_id, key = session
        now = self._now() if arrival_now is None else arrival_now
        members = self._note_member(room_id, key, address, now)
        parsed = parse_pcm_position(data, self._wall_now())
        if parsed is not None:
            self._note_voice(room_id, key, parsed, now)
        if not defer_flush:
            self._flush_due_locked(now, defer_position=self._open_position(room_id, parsed, now))
        mixed_pcm = self._mix_pcm_position(room_id, key, data, arrival_now=now)
        if not defer_flush:
            self._flush_due_locked(now)
        if parsed is not None:
            self._note_activation(room_id, key, parsed)
        if mixed_pcm:
            self._echo_probe(members[key], data, now)
            return
        self._forward(room_id, key, data)

    def _note_member(
        self, room_id: str, key: int, address: tuple[str, int], now: float
    ) -> dict[int, Member]:
        """Learns the sender's current address (it may sit behind NAT and change)."""
        members = self._rooms.setdefault(room_id, {})
        previous = members.get(key)
        members[key] = Member(
            address, now, previous.last_probe_echo if previous is not None else now
        )
        return members

    def _note_voice(self, room_id: str, key: int, parsed: PcmPosition, now: float) -> None:
        started = self._voice_started.setdefault(room_id, set())
        level = (
            math.sqrt(
                sum(sample * sample for sample in parsed.samples) / max(1, len(parsed.samples))
            )
            / 32768.0
        )
        self._participant_levels.setdefault(room_id, {})[key] = (min(1.0, level), now)
        self._publish_levels_locked(room_id, now)
        if key not in started:
            started.add(key)
            self._voice_activation_position[(room_id, key)] = media_frame(parsed.timestamp)

    def _open_position(
        self, room_id: str, parsed: PcmPosition | None, now: float
    ) -> Position | None:
        """The packet's own position while it is still collecting: closing it now would cut it off."""
        if parsed is None:
            return None
        position = (
            media_frame(parsed.timestamp) // parsed.frames * parsed.frames | SHARED_TIMELINE_FLAG,
            parsed.frames,
        )
        deadlines = self._pending_mix_started.get(room_id, {})
        return position if now <= deadlines.get(position, float("-inf")) else None

    def _note_activation(self, room_id: str, key: int, parsed: PcmPosition) -> None:
        metrics = self._mix_metrics.get(room_id)
        if metrics is None:
            return
        activation = metrics.setdefault("activation_positions", {})
        if not isinstance(activation, dict):
            return
        activation.setdefault(self._participant_name(room_id, key), media_frame(parsed.timestamp))
        expected = self._expected_mixers(room_id)
        if expected and expected.issubset(self._voice_started.get(room_id, set())):
            activation["all_active_from_position"] = max(
                activation.get(name, 0) for name in activation if name != "all_active_from_position"
            )

    def _echo_probe(self, member: Member, data: bytes, now: float) -> None:
        if self._transport is not None and now - member.last_probe_echo >= 1.0:
            self._transport.sendto(data, member.address)
            member.last_probe_echo = now

    def _mix_pcm_position(
        self, room_id: str, sender_key: int, data: bytes, *, arrival_now: float | None = None
    ) -> bool:
        """Mix one shared-timeline PCM position once every expected singer has supplied it."""
        arrival_now = self._now() if arrival_now is None else arrival_now
        packet = parse_pcm_position(data, self._wall_now())
        if packet is None:
            return False
        metrics = self._room_metrics(room_id)
        singer = self._count_ingress(room_id, sender_key, packet, arrival_now)
        media_timestamp = media_frame(packet.timestamp)
        absolute_close = self._absolute_collection_close_wall(
            room_id, media_timestamp // packet.frames * packet.frames
        )
        if absolute_close is not None and self._wall_now() > absolute_close:
            # After a relay-thread/VM scheduling pause the kernel can contain a backlog of valid
            # but obsolete datagrams.  Creating positions for that backlog emits an old burst and
            # keeps the relay behind real time, so clients correctly late-cut hundreds of packets.
            # A missed musical deadline is final: discard it here and catch up to the current grid.
            count(metrics.setdefault("pending_lifecycle", {}), "stale_ingress_positions")
            return True
        self._trace_ingress(room_id, sender_key, packet, arrival_now)
        self._prepare_mix_timeline(room_id, packet)
        self._timestamp_frames.setdefault(room_id, {}).setdefault(media_timestamp, set()).add(
            packet.frames
        )
        self._advance_recovery(room_id, sender_key, packet)
        touched = self._store_pcm_segments(room_id, sender_key, packet)
        self._note_collection_slack(room_id, sender_key, touched, arrival_now, singer)
        self._mix_complete_positions(room_id, touched)
        return True

    def _count_ingress(
        self, room_id: str, sender_key: int, packet: PcmPosition, arrival_now: float
    ) -> dict[str, int]:
        metrics = self._room_metrics(room_id)
        count(metrics, "ingress_packets")
        if any(packet.samples):
            count(metrics, "ingress_nonzero_packets")
        record_energy(metrics, "ingress", packet.samples)
        name = self._participant_name(room_id, sender_key)
        singer = participant_metrics(metrics, name)
        record_ingress_cadence(metrics, name, arrival_now, media_frame(packet.timestamp))
        singer["ingress_packets"] += 1
        singer["ingress_nonzero_packets"] += int(any(packet.samples))
        return singer

    def _trace_ingress(
        self, room_id: str, sender_key: int, packet: PcmPosition, arrival_now: float
    ) -> None:
        ingress_trace = self._room_metrics(room_id)["ingress_trace"]
        if len(ingress_trace) >= _TRACE_LIMIT:
            return
        media_timestamp = media_frame(packet.timestamp)
        ingress_trace.append(
            {
                "participant": self._participant_name(room_id, sender_key),
                "timestamp": media_timestamp,
                "bin_start": media_timestamp // packet.frames * packet.frames,
                "frames": packet.frames,
                "nonzero": any(packet.samples),
                "arrival_now": arrival_now,
            }
        )

    def _note_collection_slack(
        self,
        room_id: str,
        sender_key: int,
        touched: set[Position],
        arrival_now: float,
        singer: dict[str, int],
    ) -> None:
        slack_samples = self._room_metrics(room_id)["collection_slack_samples"]
        for position in touched:
            singer["assigned_positions"] += 1
            deadline = self._pending_mix_started.get(room_id, {}).get(position)
            if deadline is not None and len(slack_samples) < _TRACE_LIMIT:
                slack_samples.append(
                    {
                        "participant": self._participant_name(room_id, sender_key),
                        "position": media_frame(position[0]),
                        "arrival_now": arrival_now,
                        "deadline_now": deadline,
                        "slack_ms": (deadline - arrival_now) * 1_000.0,
                        "after_close": arrival_now > deadline,
                    }
                )

    def _mix_complete_positions(self, room_id: str, touched: set[Position]) -> None:
        for position in touched:
            inputs = self._pending_mix.get(room_id, {}).get(position)
            if inputs is not None and self._inputs_complete(room_id, inputs):
                for key in self._expected_mixers(room_id):
                    self._deadline_misses.pop((room_id, key), None)
                    self._miss_history.pop((room_id, key), None)
                    self._miss_started_at.pop((room_id, key), None)
                self._finish_mix_position(room_id, position, inputs)

    def _prepare_mix_timeline(self, room_id: str, packet: PcmPosition) -> None:
        start = media_frame(packet.timestamp)
        latest_end = self._latest_mix_input_end.get(room_id)
        if latest_end is not None and start + _TIMELINE_RESTART_FRAMES < latest_end:
            # A new performance (or a backward seek) may legitimately reuse the same musical
            # positions. Retained duplicate protection belongs only to the previous performance.
            self._clear_room_positions_locked(room_id)
            epoch = (self._mix_epochs.get(room_id, 1) + 1) & 0xFFFF_FFFF
            self._mix_epochs[room_id] = epoch or 1
            latest_end = None
        self._latest_mix_input_end[room_id] = max(latest_end or 0, start + packet.frames)

    def _store_pcm_segments(
        self, room_id: str, sender_key: int, packet: PcmPosition
    ) -> set[Position]:
        media_start = media_frame(packet.timestamp)
        media_end = media_start + packet.frames
        bin_start = media_start // packet.frames * packet.frames
        touched: set[Position] = set()
        while bin_start < media_end:
            position = (bin_start | SHARED_TIMELINE_FLAG, packet.frames)
            touched.add(position)
            self._store_pcm_overlap(room_id, sender_key, packet, position)
            bin_start += packet.frames
        return touched

    def _store_pcm_overlap(
        self, room_id: str, sender_key: int, packet: PcmPosition, position: Position
    ) -> None:
        event = self._overlap_event(room_id, sender_key, packet, position)
        metrics = self._room_metrics(room_id)
        if position in self._mixed_positions.setdefault(room_id, set()):
            count(metrics.setdefault("pending_lifecycle", {}), "late_dropped_positions")
            return  # an expired/duplicate sample is never emitted on a later beat
        self._seen_pcm_positions.setdefault(room_id, {}).setdefault(position, set()).add(sender_key)
        self._seen_pcm_arrivals.setdefault(room_id, {}).setdefault(position, {})[sender_key] = (
            self._now()
        )
        bin_start, frames = media_frame(position[0]), position[1]
        media_start = media_frame(packet.timestamp)
        overlap_start = max(bin_start, media_start)
        overlap_end = min(bin_start + frames, media_start + packet.frames)
        event["overlap_start"] = overlap_start - bin_start
        event["overlap_end"] = overlap_end - bin_start
        histogram = metrics.setdefault("overlap_histogram", {})
        if overlap_end > overlap_start and isinstance(histogram, dict):
            count(histogram, str(overlap_end - overlap_start))
        event["insert_attempted"] = True
        if overlap_start >= overlap_end:
            return
        source_offset = overlap_start - media_start
        self._insert_overlap(
            room_id,
            sender_key,
            packet,
            position,
            (
                overlap_start - bin_start,
                packet.samples[source_offset : source_offset + overlap_end - overlap_start],
            ),
        )
        event["inserted"] = True
        event["inputs_after"] = self._participant_names(
            room_id, self._pending_mix[room_id][position]
        )

    def _overlap_event(
        self, room_id: str, sender_key: int, packet: PcmPosition, position: Position
    ) -> dict[str, object]:
        """A packet's arrival at one position, traced so a later miss can be explained."""
        lifecycle = self._room_metrics(room_id).setdefault("position_lifecycle", [])
        pending = self._pending_mix.setdefault(room_id, {}).get(position)
        inputs_before = [] if pending is None else self._participant_names(room_id, pending)
        event: dict[str, object] = {
            "position": media_frame(position[0]),
            "frames": position[1],
            "participant": self._participant_name(room_id, sender_key),
            "pending_found": pending is not None,
            "pending_closed": position in self._mixed_positions.setdefault(room_id, set()),
            "participant_expected": sender_key in self._expected_mixers(room_id),
            "insert_attempted": False,
            "inserted": False,
            "inputs_before": inputs_before,
            "inputs_after": inputs_before,
            "packet_timestamp": media_frame(packet.timestamp),
            "packet_frames": packet.frames,
            "arrival_monotonic": self._now(),
        }
        if isinstance(lifecycle, list) and len(lifecycle) < _TRACE_LIMIT:
            lifecycle.append(event)
        return event

    def _insert_overlap(
        self,
        room_id: str,
        sender_key: int,
        packet: PcmPosition,
        position: Position,
        segment: tuple[int, tuple[int, ...]],
    ) -> None:
        inputs = self._pending_mix.setdefault(room_id, {}).setdefault(position, {})
        if not inputs:
            count(
                self._room_metrics(room_id).setdefault("pending_lifecycle", {}), "created_positions"
            )
        pending = inputs.setdefault(
            sender_key, PendingPcm.empty(position[1], packet.ingress_lateness_frames)
        )
        pending.ingress_lateness_frames = max(
            pending.ingress_lateness_frames, packet.ingress_lateness_frames
        )
        pending.write(*segment)
        started = self._now()
        absolute_close = self._absolute_collection_close_wall(room_id, media_frame(position[0]))
        if absolute_close is None:
            deadline = started + MIX_COLLECTION_SECONDS
        else:
            # Packet timestamps use the server's wall-clock musical epoch; scheduling uses
            # monotonic time. Comparing them directly left an incomplete position pending forever.
            # A late singer may consume its own position, but must not hold an already available
            # singer until the room's return budget has also expired.  The absolute musical
            # deadline remains the outer bound; the fixed collection span keeps timeliness ahead
            # of completeness inside that bound.
            deadline = min(
                started + MIX_COLLECTION_SECONDS,
                started + max(0.0, absolute_close - self._wall_now()),
            )
        self._pending_mix_started.setdefault(room_id, {}).setdefault(position, deadline)
        self._pending_mix_arrived.setdefault(room_id, {}).setdefault(position, started)

    def _reset_recovery(self, room_id: str, sender_key: int) -> None:
        recovery_key = (room_id, sender_key)
        self._recovery_packets[recovery_key] = 0
        self._recovery_next_frame.pop(recovery_key, None)

    def _advance_recovery(self, room_id: str, sender_key: int, packet: PcmPosition) -> None:
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
        if on_time_frames is not None and packet.ingress_lateness_frames > on_time_frames:
            self._reset_recovery(room_id, sender_key)
            return
        frame = media_frame(packet.timestamp)
        next_frame = self._recovery_next_frame.get(recovery_key)
        if next_frame is not None and frame + packet.frames == next_frame:
            return  # a redundant copy proves neither a new success nor a recovery failure
        consecutive = next_frame == frame
        recovered = self._recovery_packets.get(recovery_key, 0) + 1 if consecutive else 1
        self._recovery_packets[recovery_key] = recovered
        self._recovery_next_frame[recovery_key] = frame + packet.frames
        if recovered >= _RECOVERY_PACKETS:
            excluded.remove(sender_key)
            self._reset_recovery(room_id, sender_key)
