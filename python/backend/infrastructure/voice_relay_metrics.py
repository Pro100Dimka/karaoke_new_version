"""The relay's diagnostic counters: what reached it, what it mixed and how its sends were paced."""

from __future__ import annotations

from typing import Iterable, cast

_ENERGY_TRACE_PACKET_LIMIT = 2_000  # enough for diagnostics without tracing PCM forever
PIPELINE_GAP_CLASSIFICATION_SECONDS = 0.020
PIPELINE_GAP_REASONS = (
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
SLACK_KEYS = (
    "ingress_slack_packets",
    "ingress_slack_negative_packets",
    "ingress_slack_minimum_ms",
    "ingress_slack_p5_ms",
    "ingress_slack_p50_ms",
)
_NATIVE_COUNTERS = (
    "packets",
    "stalls",
    "pipeline_position",
    "pipeline_generation",
    "complete_positions",
    "partial_positions",
    "missing_contributions",
    "ingress_nonzero_packets",
    "ingress_peak",
    "recipient_nonzero_packets",
    "recipient_peak",
)
_NATIVE_DURATIONS = ("latest_gap_ms", "maximum_gap_ms", "last_send_monotonic_ms")
# Stages only the Python mixer measures; the native relay reports none of them.
_PYTHON_ONLY_DURATIONS = (
    "pipeline_position_wait_ms",
    "pipeline_mix_build_ms",
    "pipeline_sendto_ms",
    "pipeline_ingress_gap_latest_ms",
    "pipeline_ingress_gap_maximum_ms",
)


def new_mix_metrics() -> dict[str, object]:
    """A room's counters before its first voice packet."""
    return {
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
            "created_positions": 0,
            "complete_nonempty_positions": 0,
            "mixed_positions": 0,
            "closed_partial_positions": 0,
            "closed_empty_positions": 0,
            "late_dropped_positions": 0,
            "excluded_positions": 0,
            "drained_positions": 0,
            "pending_at_end": 0,
            "first_unmixed_positions": [],
        },
    }


def count(counters: dict, name: str, amount: int = 1) -> None:
    counters[name] = counters.get(name, 0) + amount


def slack_summary(values: Iterable[float]) -> dict[str, float]:
    """How early a singer's packets reached their position's close (negative: too late)."""
    ordered = sorted(values)
    if not ordered:
        return {key: 0.0 for key in SLACK_KEYS}
    return {
        "ingress_slack_packets": float(len(ordered)),
        "ingress_slack_negative_packets": float(sum(value < 0.0 for value in ordered)),
        "ingress_slack_minimum_ms": ordered[0],
        "ingress_slack_p5_ms": ordered[len(ordered) * 5 // 100],
        "ingress_slack_p50_ms": ordered[len(ordered) // 2],
    }


def classify_pipeline_gap(
    *,
    gap: float,
    generation_changed: bool,
    ingress_gap_ms: float,
    position_wait_ms: float,
    mix_build_ms: float,
    sendto_ms: float,
) -> str:
    if gap <= PIPELINE_GAP_CLASSIFICATION_SECONDS:
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
        if duration_ms > PIPELINE_GAP_CLASSIFICATION_SECONDS * 1_000.0:
            return reason
    return "SERVER_EVENT_LOOP_STALL"


def record_energy(metrics: dict[str, object], stage: str, samples: tuple[int, ...]) -> None:
    energy = metrics.setdefault("energy_trace", {})
    if not isinstance(energy, dict):
        return
    values = energy.setdefault(
        stage,
        {
            "packets": 0,
            "nonzero_packets": 0,
            "samples": 0,
            "nonzero_samples": 0,
            "sum_squares": 0.0,
            "nonzero_sum_squares": 0.0,
            "peak": 0,
        },
    )
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


def energy_report(energy: dict) -> dict[str, dict]:
    """Each stage's counters with its RMS and peak as fractions of full scale."""
    return {
        stage: {
            **values,
            "rms": (values["sum_squares"] / max(1, values["samples"])) ** 0.5 / 32768.0,
            "rms_nonzero": (values["nonzero_sum_squares"] / max(1, values["nonzero_samples"]))
            ** 0.5
            / 32768.0,
            "peak": values["peak"] / 32768.0,
        }
        for stage, values in energy.items()
    }


def participant_metrics(metrics: dict[str, object], participant: str) -> dict[str, int]:
    trace = metrics.setdefault("participant_trace", {})
    if not isinstance(trace, dict):
        return {}
    return cast(
        dict[str, int],
        trace.setdefault(
            participant,
            {
                "ingress_packets": 0,
                "ingress_nonzero_packets": 0,
                "assigned_positions": 0,
                "mixed_positions": 0,
                "mixed_nonzero_positions": 0,
                "recipient_packets": 0,
                "recipient_nonzero_packets": 0,
            },
        ),
    )


def record_ingress_cadence(
    metrics: dict[str, object], participant: str, arrived_at: float, position: int
) -> None:
    trace = metrics.setdefault("ingress_cadence", {})
    if not isinstance(trace, dict):
        return
    values = trace.setdefault(
        participant,
        {
            "packets": 0,
            "latest_gap_ms": 0.0,
            "maximum_gap_ms": 0.0,
            "last_ingress_monotonic_ms": 0.0,
            "last_position": 0,
        },
    )
    previous = float(values["last_ingress_monotonic_ms"]) / 1_000.0
    gap_ms = 0.0 if previous == 0.0 else round((arrived_at - previous) * 1_000.0, 3)
    values["packets"] = int(values["packets"]) + 1
    values["latest_gap_ms"] = gap_ms
    values["maximum_gap_ms"] = max(float(values["maximum_gap_ms"]), gap_ms)
    values["last_ingress_monotonic_ms"] = round(arrived_at * 1_000.0, 3)
    values["last_position"] = position


def latest_ingress_gap_ms(ingress_cadence: object, field: str = "latest_gap_ms") -> float:
    """The largest of the singers' ingress gaps (`field`) in an ingress cadence trace."""
    values = (
        [item for item in ingress_cadence.values() if isinstance(item, dict)]
        if isinstance(ingress_cadence, dict)
        else []
    )
    return max((float(item.get(field, 0.0)) for item in values), default=0.0)


def native_send_metrics(native: dict[str, int | float]) -> dict[str, int | float]:
    """The native relay's view of one recipient, in the Python relay's metric names."""
    return {
        **{name: int(native.get(name, 0)) for name in _NATIVE_COUNTERS},
        **{name: float(native.get(name, 0.0)) for name in _NATIVE_DURATIONS},
        **{key: float(native.get(key, 0.0)) for key in SLACK_KEYS},
        **{name: 0.0 for name in _PYTHON_ONLY_DURATIONS},
        **{f"gap_{reason}": 0 for reason in PIPELINE_GAP_REASONS},
    }


def recorded_send_metrics(room_metrics: dict, participant_id: str) -> dict[str, int | float]:
    """One recipient's send cadence and pipeline stages as this relay recorded them."""
    return {
        **_send_cadence(room_metrics, participant_id),
        **_participant_counters(room_metrics, participant_id),
        **slack_summary(
            float(sample["slack_ms"])
            for sample in room_metrics.get("collection_slack_samples", [])
            if isinstance(sample, dict) and sample.get("participant") == participant_id
        ),
        **_pipeline_stages(room_metrics, participant_id),
    }


def _send_cadence(room_metrics: dict, participant_id: str) -> dict[str, int | float]:
    trace = room_metrics.get("recipient_send_trace", {})
    values = trace.get(participant_id, {}) if isinstance(trace, dict) else {}
    return {
        "packets": int(values.get("packets", 0)),
        "latest_gap_ms": float(values.get("latest_gap_ms", 0.0)),
        "maximum_gap_ms": float(values.get("maximum_gap_ms", 0.0)),
        "stalls": int(values.get("stalls", 0)),
        "last_send_monotonic_ms": float(values.get("last_send_monotonic_ms", 0.0)),
        "complete_positions": int(room_metrics.get("complete_positions", 0)),
        "partial_positions": int(room_metrics.get("partial_positions", 0)),
    }


def _participant_counters(room_metrics: dict, participant_id: str) -> dict[str, int | float]:
    participant = room_metrics.get("participant_trace", {}).get(participant_id, {})
    energy = room_metrics.get("energy_trace", {})
    return {
        "missing_contributions": int(participant.get("missing_positions", 0)),
        "ingress_nonzero_packets": int(participant.get("ingress_nonzero_packets", 0)),
        "ingress_peak": int(energy.get("ingress", {}).get("peak", 0)),
        "recipient_nonzero_packets": int(participant.get("recipient_nonzero_packets", 0)),
        "recipient_peak": int(energy.get("recipient_mix", {}).get("peak", 0)),
    }


def _latest_pipeline_event(room_metrics: dict, participant_id: str) -> dict:
    pipeline_trace = room_metrics.get("pipeline_gap_trace", [])
    if not isinstance(pipeline_trace, list):
        return {}
    return next(
        (
            event
            for event in reversed(pipeline_trace)
            if isinstance(event, dict) and event.get("recipient") == participant_id
        ),
        {},
    )


def _pipeline_stages(room_metrics: dict, participant_id: str) -> dict[str, int | float]:
    pipeline = _latest_pipeline_event(room_metrics, participant_id)
    ingress = pipeline.get("ingress", {})
    classifications = room_metrics.get("pipeline_gap_classifications", {})
    return {
        "pipeline_position": int(pipeline.get("position", 0)),
        "pipeline_generation": int(pipeline.get("generation", 0)),
        "pipeline_position_wait_ms": float(pipeline.get("position_wait_ms", 0.0)),
        "pipeline_mix_build_ms": float(pipeline.get("mix_build_ms", 0.0)),
        "pipeline_sendto_ms": float(pipeline.get("sendto_ms", 0.0)),
        "pipeline_ingress_gap_latest_ms": latest_ingress_gap_ms(ingress, "latest_gap_ms"),
        "pipeline_ingress_gap_maximum_ms": latest_ingress_gap_ms(ingress, "maximum_gap_ms"),
        **{
            f"gap_{reason}": int(classifications.get(reason, 0))
            if isinstance(classifications, dict)
            else 0
            for reason in PIPELINE_GAP_REASONS
        },
    }
