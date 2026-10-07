"""What the voice relay knows: its sessions, the rooms' pending positions and every singer's health.

One lock (owned by ``VoiceRelay``) guards all of it; every ``*_locked`` method expects it held.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Protocol

from backend.infrastructure.voice_pending import PendingPcm
from backend.infrastructure.voice_relay_metrics import new_mix_metrics
from backend.room.timing_policy import ROOM_TIMING
from backend.room.voice_protocol import VOICE_SAMPLE_RATE_HZ

_PARTICIPANT_LEVEL_STALE_SECONDS = 0.3
# Rooms keyed by their room id, positions by (flagged timestamp, frames), participants by wire key.
Position = tuple[int, int]
RoomKey = tuple[str, int]


class DatagramSender(Protocol):
    def sendto(self, data: bytes, address: tuple[str, int]) -> object: ...


@dataclass(slots=True)
class Member:
    address: tuple[str, int]
    last_seen: float
    last_probe_echo: float


@dataclass(frozen=True, slots=True)
class RelayHooks:
    """How the relay reaches a native data plane, when one does the actual mixing."""

    control_command: Callable[[str], None] | None = None
    recipient_metrics: Callable[[str, str], dict[str, int | float]] | None = None
    participant_levels: Callable[[str], dict[str, float]] | None = None


class RelayState:
    def __init__(
        self,
        *,
        now: Callable[[], float] = time.monotonic,
        wall_now: Callable[[], float] = time.time,
        mix_packet_copies: int = 2,
        hooks: RelayHooks = RelayHooks(),
    ) -> None:
        self._now = now
        self._wall_now = wall_now
        self._mix_packet_copies = max(1, mix_packet_copies)
        self._control_command = hooks.control_command
        self._recipient_metrics = hooks.recipient_metrics
        self._native_participant_levels = hooks.participant_levels
        self._lock = threading.Lock()
        self._transport: DatagramSender | None = None
        self._init_sessions()
        self._init_positions()
        self._init_health()

    def _init_sessions(self) -> None:
        # A voice session belongs to one room. The 32-bit wire key is unique only inside that room,
        # so a participant whose key collides in another room can never take over this session.
        self._sessions: dict[RoomKey, tuple[str, int]] = {}  # (room, key) -> (id, token)
        self._participant_session: dict[str, RoomKey] = {}  # id -> (room, key)
        self._token_identity: dict[int, RoomKey] = {}
        self._rooms: dict[str, dict[int, Member]] = {}
        self._participant_levels: dict[str, dict[int, tuple[float, float]]] = {}
        # Per-listener source gains keep personal volume/mute choices inside that listener's
        # server-produced mix-minus. They never alter the source heard by anyone else.
        self._recipient_source_gains: dict[tuple[str, int, int], float] = {}
        self._level_push: dict[str, object] = {"listener": None, "last": {}, "published": {}}

    def _init_positions(self) -> None:
        self._pending_mix: dict[str, dict[Position, dict[int, PendingPcm]]] = {}
        self._pending_mix_started: dict[str, dict[Position, float]] = {}
        self._pending_mix_arrived: dict[str, dict[Position, float]] = {}
        self._room_playout_delay_seconds: dict[str, float] = {}
        self._room_return_reserve_seconds: dict[str, float] = {}
        self._mixed_positions: dict[str, set[Position]] = {}
        self._seen_pcm_positions: dict[str, dict[Position, set[int]]] = {}
        self._seen_pcm_arrivals: dict[str, dict[Position, dict[int, float]]] = {}
        self._mix_sequences: dict[RoomKey, int] = {}
        self._mix_epochs: dict[str, int] = {}
        self._latest_mix_input_end: dict[str, int] = {}
        # Diagnostic counters and traces only; their shapes are documented by new_mix_metrics().
        self._mix_metrics: dict[str, dict] = {}
        self._timestamp_frames: dict[str, dict[int, set[int]]] = {}

    def _init_health(self) -> None:
        self._room_eligible_mixers: dict[str, set[int]] = {}
        self._excluded_mixers: dict[str, set[int]] = {}
        self._voice_started: dict[str, set[int]] = {}
        self._voice_activation_position: dict[RoomKey, int] = {}
        self._miss_history: dict[RoomKey, list[dict[str, object]]] = {}
        self._deadline_misses: dict[RoomKey, int] = {}
        self._miss_started_at: dict[RoomKey, float] = {}
        self._recovery_packets: dict[RoomKey, int] = {}
        self._recovery_next_frame: dict[RoomKey, int] = {}

    def _room_metrics(self, room_id: str) -> dict:
        return self._mix_metrics.setdefault(room_id, new_mix_metrics())

    def _owns_locked(self, room_id: str, participant_id: str, token: int) -> bool:
        """Whether `token` is this participant's current voice session in this room."""
        session = self._participant_session.get(participant_id)
        return (
            session is not None
            and session[0] == room_id
            and self._token_identity.get(token) == session
        )

    def _participant_name(self, room_id: str, key: int) -> str:
        session = self._sessions.get((room_id, key))
        return str(key) if session is None else session[0]

    def _participant_names(self, room_id: str, keys: Iterable[int]) -> list[str]:
        return sorted(self._participant_name(room_id, key) for key in keys)

    def _session_token(self, room_id: str, key: int) -> int | None:
        session = self._sessions.get((room_id, key))
        return None if session is None else session[1]

    def _room_session_keys(self, room_id: str) -> set[int]:
        return {key for room, key in self._sessions if room == room_id}

    def _expected_mixers(self, room_id: str) -> set[int]:
        excluded = self._excluded_mixers.setdefault(room_id, set())
        eligible = self._room_eligible_mixers.get(room_id)
        return {
            key
            for key in self._room_session_keys(room_id)
            if key not in excluded and (eligible is None or key in eligible)
        }

    def _inputs_complete(self, room_id: str, inputs: dict[int, PendingPcm]) -> bool:
        expected = self._expected_mixers(room_id)
        return expected.issubset(inputs) and all(inputs[key].complete() for key in expected)

    def _return_reserve(self, room_id: str) -> float:
        return self._room_return_reserve_seconds.get(
            room_id, ROOM_TIMING.return_requirement.fallback_ms / 1_000.0
        )

    def _absolute_collection_close_wall(self, room_id: str, bin_start: int) -> float | None:
        delay = self._room_playout_delay_seconds.get(room_id)
        if delay is None:
            return None
        return bin_start / VOICE_SAMPLE_RATE_HZ + max(0.0, delay - self._return_reserve(room_id))

    def _participant_levels_locked(self, room_id: str) -> dict[str, float]:
        now = self._now()
        return {
            self._participant_name(room_id, key): level
            if now - measured_at <= _PARTICIPANT_LEVEL_STALE_SECONDS
            else 0.0
            for key, (level, measured_at) in self._participant_levels.get(room_id, {}).items()
        }

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

    def _clear_room_positions_locked(self, room_id: str) -> None:
        """Forgets a room's pending, mixed and excluded positions: its timeline starts over."""
        _pop_from(
            room_id,
            self._pending_mix,
            self._pending_mix_started,
            self._pending_mix_arrived,
            self._mixed_positions,
            self._excluded_mixers,
            self._seen_pcm_positions,
            self._seen_pcm_arrivals,
            self._timestamp_frames,
        )
        _drop_room_keys(room_id, self._deadline_misses)
        for key in [key for key in self._recovery_packets if key[0] == room_id]:
            self._recovery_packets.pop(key, None)
            self._recovery_next_frame.pop(key, None)

    def _reset_room_mix_locked(self, room_id: str) -> None:
        """Forgets every pending and mixed position of a room whose deadline or singers changed."""
        for key in [key for key in self._deadline_misses if key[0] == room_id]:
            self._miss_started_at.pop(key, None)
        self._clear_room_positions_locked(room_id)
        self._mix_metrics.pop(room_id, None)
        self._voice_started.pop(room_id, None)
        _drop_room_keys(room_id, self._voice_activation_position)
        _drop_room_keys(room_id, self._miss_history)

    def _forget_locked(self, participant_id: str) -> None:
        session = self._participant_session.pop(participant_id, None)
        if session is None:
            return
        room_id, key = session
        _, token = self._sessions.pop(session)
        self._token_identity.pop(token, None)
        if self._control_command is not None:
            self._control_command(f"FORGET\t{participant_id}")
        members = self._rooms.get(room_id, {})
        members.pop(key, None)
        _pop_from(
            session,
            self._deadline_misses,
            self._miss_started_at,
            self._recovery_packets,
            self._recovery_next_frame,
            self._voice_activation_position,
            self._miss_history,
        )
        self._voice_started.get(room_id, set()).discard(key)
        self._participant_levels.get(room_id, {}).pop(key, None)
        for gain_key in [
            item for item in self._recipient_source_gains if item[0] == room_id and key in item[1:]
        ]:
            self._recipient_source_gains.pop(gain_key, None)
        if not members:
            self._drop_room_locked(room_id)

    def _drop_room_locked(self, room_id: str) -> None:
        """Forgets everything about a room whose last voice member left."""
        _pop_from(
            room_id,
            self._rooms,
            self._pending_mix,
            self._pending_mix_started,
            self._pending_mix_arrived,
            self._mixed_positions,
            self._excluded_mixers,
            self._voice_started,
            self._seen_pcm_positions,
            self._seen_pcm_arrivals,
            self._mix_metrics,
            self._timestamp_frames,
            self._participant_levels,
            self._latest_mix_input_end,
            self._mix_epochs,
        )
        for gain_key in [item for item in self._recipient_source_gains if item[0] == room_id]:
            self._recipient_source_gains.pop(gain_key, None)
        _drop_room_keys(
            room_id,
            self._voice_activation_position,
            self._deadline_misses,
            self._miss_started_at,
            self._recovery_packets,
            self._recovery_next_frame,
            self._miss_history,
            self._mix_sequences,
        )


def _pop_from(key: object, *mappings: dict) -> None:
    for mapping in mappings:
        mapping.pop(key, None)


def _drop_room_keys(room_id: str, *mappings: dict) -> None:
    """Removes a room's entries from mappings keyed by (room id, ...)."""
    for mapping in mappings:
        for key in [key for key in mapping if key[0] == room_id]:
            mapping.pop(key, None)
