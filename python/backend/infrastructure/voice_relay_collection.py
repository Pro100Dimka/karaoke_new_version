"""Closing positions: at its fixed deadline a position is mixed with whoever arrived, and a singer
who keeps missing deadlines is excluded until it recovers."""

from __future__ import annotations

from backend.infrastructure.voice_pending import PendingPcm
from backend.infrastructure.voice_relay_emit import MixedPosition, RelayEmission
from backend.infrastructure.voice_relay_metrics import count, participant_metrics
from backend.infrastructure.voice_relay_state import Position
from backend.infrastructure.voice_wire import media_frame
from backend.room.timing_policy import ROOM_TIMING
from backend.room.voice_protocol import VOICE_SAMPLE_RATE_HZ

MIX_COLLECTION_SECONDS = ROOM_TIMING.collection_budget_ms / 1_000.0
_EXCLUSION_MISSES = 3  # one isolated 2.5 ms loss must not mute a singer for the recovery window
_EXCLUSION_GRACE_SECONDS = 0.5  # packet misses alone are degraded state, not a disconnect
# At 400 packets/s this retains ten seconds of duplicate/late-packet protection.
_RETAINED_MIXED_POSITIONS = 4_000


def _miss_classification(
    seen: bool, deadline: float | None, arrival: float | None, event: dict | None
) -> str:
    """Why a singer's samples were missing when its position closed."""
    if seen and deadline is not None and arrival is not None and arrival > deadline:
        return "ARRIVED_AFTER_CLOSE"
    if event is None:
        return "NO_INGRESS"
    if event.get("pending_closed"):
        return "PENDING_ALREADY_CLOSED"
    if not event.get("participant_expected"):
        return "PARTICIPANT_NOT_EXPECTED"
    if not event.get("inserted"):
        return "INSERT_REJECTED"
    return "INSERTED_BUT_MISSING_AT_CLOSE"


class RelayCollection(RelayEmission):
    def _flush_due_locked(self, now: float, *, defer_position: Position | None = None) -> None:
        for room_id, positions in tuple(self._pending_mix.items()):
            for position, inputs in tuple(positions.items()):
                if position == defer_position:
                    continue
                deadlines = self._pending_mix_started.get(room_id, {})
                if now < deadlines.get(position, now + MIX_COLLECTION_SECONDS):
                    continue
                self._close_due_position(room_id, position, inputs, now)

    def _close_due_position(
        self, room_id: str, position: Position, inputs: dict[int, PendingPcm], now: float
    ) -> None:
        excluded = self._excluded_mixers.setdefault(room_id, set())
        expected = {key for key in self._room_session_keys(room_id) if key not in excluded}
        started = self._voice_started.setdefault(room_id, set())
        complete = {key for key, samples in inputs.items() if samples.complete()}
        # Do not start miss accounting until every eligible singer has supplied at least one
        # valid timeline packet. During this activation barrier, early scheduling gaps are
        # startup state, not evidence that a participant is unhealthy.
        active_expected = expected if expected and expected.issubset(started) else set()
        for key in active_expected.intersection(complete):
            self._deadline_misses.pop((room_id, key), None)
            self._miss_history.pop((room_id, key), None)
        newly_excluded: dict[int, int] = {}
        for key in active_expected.difference(complete):
            misses, exclude = self._record_miss(room_id, key, position, inputs, complete, now)
            if exclude:
                newly_excluded[key] = misses
        excluded.update(newly_excluded)
        for key, misses in newly_excluded.items():
            self._note_exclusion(room_id, key, position, misses, complete)
        self._finish_mix_position(room_id, position, inputs)

    def _record_miss(
        self,
        room_id: str,
        key: int,
        position: Position,
        inputs: dict[int, PendingPcm],
        complete: set[int],
        now: float,
    ) -> tuple[int, bool]:
        """Counts a singer's missed position; returns its consecutive misses and whether to exclude it."""
        miss_key = (room_id, key)
        misses = self._deadline_misses.get(miss_key, 0) + 1
        self._deadline_misses[miss_key] = misses
        started_at = self._miss_started_at.setdefault(miss_key, now)
        history = self._miss_history.setdefault(miss_key, [])
        record = self._miss_record(room_id, key, position, inputs, now)
        history.append(
            {
                **record,
                "consecutive_misses": misses,
                "received_ids": self._participant_names(room_id, complete),
            }
        )
        count(
            self._room_metrics(room_id).setdefault("partial_reason_counts", {}),
            str(record["classification"]),
        )
        del history[:-8]
        if misses >= _EXCLUSION_MISSES and now - started_at >= _EXCLUSION_GRACE_SECONDS:
            self._deadline_misses.pop(miss_key, None)
            return misses, True
        return misses, False

    def _miss_record(
        self, room_id: str, key: int, position: Position, inputs: dict[int, PendingPcm], now: float
    ) -> dict[str, object]:
        deadline = self._pending_mix_started.get(room_id, {}).get(position)
        arrival = self._seen_pcm_arrivals.get(room_id, {}).get(position, {}).get(key)
        seen = key in self._seen_pcm_positions.get(room_id, {}).get(position, set())
        lifecycle_events = self._mix_metrics.get(room_id, {}).get("position_lifecycle", [])
        participant = self._participant_name(room_id, key)
        fragments = (
            [
                item
                for item in lifecycle_events
                if isinstance(item, dict)
                and item.get("position") == media_frame(position[0])
                and item.get("frames") == position[1]
                and item.get("participant") == participant
            ]
            if isinstance(lifecycle_events, list)
            else []
        )
        event = fragments[-1] if fragments else None
        if event is not None:
            event["close_monotonic"] = now
            event["close_deadline"] = deadline
        classification = _miss_classification(seen, deadline, arrival, event)
        return {
            "position": media_frame(position[0]),
            "classification": classification,
            "position_lifecycle": event,
            "coverage": {
                self._participant_name(room_id, item): samples.coverage()
                for item, samples in inputs.items()
            },
            "fragments": fragments,
            "late_by_ms": (
                None
                if classification != "ARRIVED_AFTER_CLOSE" or deadline is None or arrival is None
                else (arrival - deadline) * 1_000.0
            ),
        }

    def _note_exclusion(
        self, room_id: str, key: int, position: Position, misses: int, complete: set[int]
    ) -> None:
        metrics = self._room_metrics(room_id)
        count(metrics.setdefault("pending_lifecycle", {}), "excluded_positions")
        self._recovery_packets[(room_id, key)] = 0
        self._recovery_next_frame.pop((room_id, key), None)
        exclusion_trace = metrics.setdefault("exclusion_trace", [])
        if isinstance(exclusion_trace, list) and len(exclusion_trace) < 100:
            exclusion_trace.append(
                {
                    "participant": self._participant_name(room_id, key),
                    "position": media_frame(position[0]),
                    "consecutive_misses": misses,
                    "received_ids": self._participant_names(room_id, complete),
                    "miss_history": list(self._miss_history.get((room_id, key), [])),
                }
            )

    def _finish_mix_position(
        self, room_id: str, position: Position, inputs: dict[int, PendingPcm]
    ) -> None:
        expected = self._expected_mixers(room_id)
        complete = self._count_finished_position(room_id, position, inputs, expected)
        audible = {
            key: tuple(samples.samples)
            for key, samples in inputs.items()
            if key in expected and samples.complete()
        }
        metrics = self._room_metrics(room_id)
        if complete and expected and not audible:
            examples = metrics.setdefault("pending_lifecycle", {}).setdefault(
                "first_unmixed_positions", []
            )
            if len(examples) < 10:
                examples.append(
                    {
                        "position": media_frame(position[0]),
                        "expected": self._participant_names(room_id, expected),
                        "received": self._participant_names(room_id, inputs),
                        "reason": "COMPLETE_WITHOUT_AUDIBLE_INPUT",
                    }
                )
        for key, voice in audible.items():
            mixed_metrics = participant_metrics(metrics, self._participant_name(room_id, key))
            mixed_metrics["mixed_positions"] += 1
            mixed_metrics["mixed_nonzero_positions"] += int(any(voice))
        self._emit_mix(room_id, self._mixed_position(room_id, position, inputs, audible, complete))
        self._release_position(room_id, position)

    def _mixed_position(
        self,
        room_id: str,
        position: Position,
        inputs: dict[int, PendingPcm],
        audible: dict[int, tuple[int, ...]],
        complete: bool,
    ) -> MixedPosition:
        finished_at = self._now()
        arrived = self._pending_mix_arrived.get(room_id, {}).get(position, finished_at)
        timestamp, frames = position
        return MixedPosition(
            timestamp,
            frames,
            audible,
            {
                key: samples.ingress_lateness_frames
                for key, samples in inputs.items()
                if key in audible
            },
            max(0, round((finished_at - arrived) * VOICE_SAMPLE_RATE_HZ)),
            {
                "position": media_frame(timestamp),
                "generation": self._mix_epochs.get(room_id, 1),
                "created_monotonic": arrived,
                "finished_monotonic": finished_at,
                "complete": complete,
            },
        )

    def _count_finished_position(
        self, room_id: str, position: Position, inputs: dict[int, PendingPcm], expected: set[int]
    ) -> bool:
        """Records a closing position in the room's counters; returns whether every singer supplied it."""
        metrics = self._room_metrics(room_id)
        count(metrics, "positions_seen")
        metrics["max_inputs_seen"] = max(metrics.get("max_inputs_seen", 0), len(inputs))
        previous_min = metrics.get("min_expected_mixers")
        metrics["min_expected_mixers"] = (
            len(expected) if previous_min is None else min(previous_min, len(expected))
        )
        metrics["max_expected_mixers"] = max(metrics.get("max_expected_mixers", 0), len(expected))
        complete = expected.issubset(inputs) and all(inputs[key].complete() for key in expected)
        lifecycle = metrics.setdefault("pending_lifecycle", {})
        if complete and expected:
            count(lifecycle, "complete_nonempty_positions")
        elif not complete and inputs:
            count(lifecycle, "closed_partial_positions")
        elif not inputs:
            count(lifecycle, "closed_empty_positions")
        count(metrics, "complete_positions" if complete else "partial_positions")
        trace = metrics.setdefault("position_trace", [])
        if isinstance(trace, list) and expected and len(trace) < 100:
            expected_ids = self._participant_names(room_id, expected)
            received_ids = self._participant_names(room_id, inputs)
            trace.append(
                {
                    "position": media_frame(position[0]),
                    "expected": expected_ids,
                    "received": received_ids,
                    "missing": sorted(set(expected_ids).difference(received_ids)),
                    "complete": complete,
                    "deadline_now": self._pending_mix_started.get(room_id, {}).get(position),
                }
            )
        return complete

    def _release_position(self, room_id: str, position: Position) -> None:
        """Forgets a mixed position, keeping it only as protection against late duplicates."""
        pending = self._pending_mix.get(room_id, {})
        pending.pop(position, None)
        for mapping in (self._pending_mix_started, self._pending_mix_arrived):
            mapping.get(room_id, {}).pop(position, None)
        self._seen_pcm_positions.get(room_id, {}).pop(position, None)
        self._seen_pcm_arrivals.get(room_id, {}).pop(position, None)
        media_timestamp = media_frame(position[0])
        if not any(media_frame(candidate) == media_timestamp for candidate, _frames in pending):
            self._timestamp_frames.get(room_id, {}).pop(media_timestamp, None)
        mixed = self._mixed_positions.setdefault(room_id, set())
        mixed.add(position)
        if len(mixed) > _RETAINED_MIXED_POSITIONS:
            mixed.remove(min(mixed))
