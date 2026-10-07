from __future__ import annotations

import logging
import secrets
import socket
import time
from typing import Callable

from backend.domain_errors import ConflictError
from backend.infrastructure.job_executor import ServiceLoop
from backend.infrastructure.voice_relay_ingress import RelayIngress
from backend.infrastructure.voice_relay_metrics import (
    energy_report,
    native_send_metrics,
    recorded_send_metrics,
)
from backend.infrastructure.voice_relay_state import DatagramSender, RelayHooks
from backend.infrastructure.voice_wire import participant_key
from backend.room.timing_policy import ROOM_TIMING

__all__ = ("DatagramSender", "RelaySocket", "VoiceRelay", "participant_key")

_MAXIMUM_DATAGRAM_BYTES = 65_535

logger = logging.getLogger(__name__)


class VoiceRelay(RelayIngress):
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
        super().__init__(
            now=now,
            wall_now=wall_now,
            mix_packet_copies=mix_packet_copies,
            hooks=RelayHooks(control_command, recipient_metrics, participant_levels),
        )

    def set_level_listener(
        self, listener: Callable[[str, dict[str, float]], None] | None
    ) -> None:
        """Publishes compact, rate-limited meter updates outside the HTTP request path."""
        with self._lock:
            self._level_push["listener"] = listener

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
            self._reset_room_mix_locked(room_id)
            if self._control_command is not None:
                participants = [] if participant_ids is None else sorted(participant_ids)
                self._control_command("\t".join(("ELIGIBLE", room_id, *participants)))

    def expect(self, room_id: str, participant_id: str, *, machine_id: str = "") -> int:
        with self._lock:
            key = participant_key(participant_id)
            owner = self._sessions.get((room_id, key))
            if owner is not None and owner[0] != participant_id:
                raise ConflictError(
                    "RoomVoiceIdentityCollision",
                    "Another participant of this room already uses this voice identity",
                    roomId=room_id,
                )
            if self._participant_session.get(participant_id, (room_id, key))[0] != room_id:
                self._forget_locked(participant_id)
            previous = self._sessions.get((room_id, key))
            if previous is not None:
                self._token_identity.pop(previous[1], None)
            token = secrets.randbits(64) or 1
            while token in self._token_identity:
                token = secrets.randbits(64) or 1
            self._sessions[(room_id, key)] = (participant_id, token)
            self._participant_session[participant_id] = (room_id, key)
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
            if not self._owns_locked(room_id, recipient_id, token):
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
            return 0 < local_port <= 65535 and self._owns_locked(room_id, participant_id, token)

    def direct_peers(
        self, room_id: str, participant_id: str, token: int
    ) -> list[dict[str, str | int]]:
        with self._lock:
            if not self._owns_locked(room_id, participant_id, token):
                return []
            # Room audio is mixed centrally. A direct route would bypass the server's musical
            # deadline and recreate a different mix on every computer.
            return []

    def authenticates(self, room_id: str, participant_id: str, token: int) -> bool:
        with self._lock:
            return self._owns_locked(room_id, participant_id, token)

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
                metrics["energy_trace"] = energy_report(energy)
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
            return native_send_metrics(self._recipient_metrics(room_id, participant_id))
        with self._lock:
            return recorded_send_metrics(self._mix_metrics.get(room_id, {}), participant_id)

    def forget(self, participant_id: str) -> None:
        with self._lock:
            self._forget_locked(participant_id)

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
            self._drain_queued(batch_now)
            self._relay.flush_due()
        except OSError:
            # A send to one unreachable member must not stop the relay for everyone else.
            logger.warning("Voice relay could not forward a packet", exc_info=True)

    def _drain_queued(self, batch_now: float) -> None:
        """Takes the datagrams already waiting, up to a bound, without blocking."""
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
