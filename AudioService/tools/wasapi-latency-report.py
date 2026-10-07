"""Classify one isolated WASAPI Shared PCM run and pack a portable report."""

import argparse
import json
import zipfile
from pathlib import Path


def number(values, key):
    try:
        return float(values.get(key, 0))
    except (TypeError, ValueError):
        return 0.0


def classify(after, before, capabilities):
    rate = number(after, "RuntimeOutputSampleRate")
    actual = number(after, "SharedEnginePeriodActualFrames")
    minimum = number(after, "SharedEnginePeriodMinimumFrames") or number(capabilities, "minPeriodFrames")
    minimum_ms = 1000 * minimum / rate if rate else 0
    queue = number(after, "RenderQueueFrames")
    internal = number(after, "LocalAudioServiceInternalMs") + number(after, "LocalResamplerDspMs")
    minimum_high = minimum_ms >= 10
    output_high = number(after, "LocalEndpointOutputMs") >= 15
    queue_high = actual > 0 and queue > 1.5 * actual
    requested_rate = number(after, "RequestedSampleRate")
    conditions = [
        (minimum_high, "PERIOD_MINIMUM_HIGH"),
        (after.get("SharedEnginePeriodFallback") == "ENGINE_PERIODICITY_LOCKED" or
         after.get("PeriodMismatchReason") == "ENGINE_PERIODICITY_LOCKED", "PERIOD_LOCKED"),
        (number(after, "LocalCaptureDeviceMs") >= 15, "CAPTURE_LATENCY_HIGH"),
        (internal >= 5, "INTERNAL_LATENCY_HIGH"),
        (queue_high, "RENDER_QUEUE_HIGH"),
        (output_high, "OUTPUT_LATENCY_HIGH"),
        (number(after, "RenderTimingPressureFrames") > number(before, "RenderTimingPressureFrames"),
         "TIMING_PRESSURE"),
        (number(after, "RenderConfirmedUnderrunFrames") >
         number(before, "RenderConfirmedUnderrunFrames"), "CONFIRMED_UNDERRUN"),
        (after.get("PeriodMismatchReason") == "FORMAT_NEGOTIATION" or
         (requested_rate > 0 and rate > 0 and requested_rate != rate), "FORMAT_FALLBACK"),
        ((minimum_high or output_high) and internal < 5 and not queue_high,
         "DRIVER_OR_WINDOWS_LIMITED"),
    ]
    causes = [label for condition, label in conditions if condition]
    return causes or ["UNKNOWN"]


def make_report(prefix, session):
    stem = Path(f"{prefix}-{session}")
    endpoint_path = Path(f"{prefix}-endpoint.json")
    samples_path = Path(f"{prefix}-samples.json")
    continuity_path = Path(f"{stem}-continuity.json")
    endpoint = json.loads(endpoint_path.read_text(encoding="utf-8-sig"))
    samples = json.loads(samples_path.read_text(encoding="utf-8-sig"))
    if isinstance(samples, dict):
        samples = [samples]
    sessions = [[]]
    for sample in samples:
        if sessions[-1] and sample.get("elapsedSeconds") == 0:
            sessions.append([])
        sessions[-1].append(sample)
    if not 1 <= session <= len(sessions):
        raise ValueError(f"Session {session} is absent from {samples_path}")
    samples = sessions[session - 1]
    if not samples:
        raise ValueError(f"Session {session} has no samples in {samples_path}")
    continuity = json.loads(continuity_path.read_text(encoding="utf-8-sig"))
    first, last = samples[0], samples[-1]
    before, after = first["diagnostics"], last["diagnostics"]
    capabilities = endpoint.get("capabilities", {})
    causes = classify(after, before, capabilities)
    rate = number(after, "RuntimeOutputSampleRate")
    actual = number(after, "SharedEnginePeriodActualFrames")
    period_ms = actual * 1000 / rate if rate else 0
    internal = number(after, "LocalAudioServiceInternalMs") + number(after, "LocalResamplerDspMs")
    queue_ms = number(after, "LocalRenderQueueMs")
    summary = {
        "endpoint": endpoint,
        "selected_period_frames": number(after, "SelectedPeriodFrames"),
        "requested_period_frames": number(after, "RequestedPeriodFrames"),
        "actual_period_frames": actual,
        "period_mismatch_reason": after.get("PeriodMismatchReason", "UNKNOWN"),
        "sample_rate_hz": rate,
        "latency_ms": {
            "capture": number(after, "LocalCaptureDeviceMs"),
            "internal": internal,
            "render_queue": queue_ms,
            "output_residual": number(after, "LocalEndpointOutputMs"),
            "estimated_total": number(after, "LocalEstimatedMonitoringMs"),
            "physical_loopback": None,
        },
        "capture": {
            "selected_period_frames": number(after, "SelectedInputPeriodFrames"),
            "requested_period_frames": number(after, "RequestedInputPeriodFrames"),
            "period_frames": number(after, "RuntimeInputPeriodFrames"),
            "mismatch_reason": after.get("InputPeriodMismatchReason", "UNKNOWN"),
            "buffer_frames": number(after, "RuntimeInputEndpointBufferFrames"),
            "event_gap_p95_us": number(after, "CaptureEventGapP95Us"),
            "event_gap_p99_us": number(after, "CaptureEventGapP99Us"),
            "packet_gap_p99_us": number(after, "CapturePacketGapP99Us"),
            "age_us": number(after, "CaptureAgeUs"),
            "packets_per_wake_max": number(after, "CapturePacketsPerWakeMax"),
            "frames_per_wake_max": number(after, "CaptureFramesPerWakeMax"),
        },
        "clock_bridge": {
            "capacity_ms": number(after, "ClockBridgeCapacityMs"),
            "target_frames": number(after, "ClockBridgeTargetFrames"),
            "fill_before_pull_p95_frames": number(after, "ClockBridgeFillBeforePullP95Frames"),
            "clock_relationship": after.get("ClockBridgeClockRelationship", "UNKNOWN"),
            "drift_ppm": number(after, "DriftPpm"),
            "fill_correction_ratio": number(after, "ClockBridgeCorrectionRatio"),
            "overruns": number(after, "ClockBridgeOverruns"),
            "underruns": number(after, "ClockBridgeUnderruns"),
            "dropped_frames": number(after, "ClockBridgeDroppedFrames"),
        },
        "internal": {
            "clock_bridge_latency_frames": number(after, "ClockBridgeLatencyFrames"),
            "resampler_dsp_ms": number(after, "LocalResamplerDspMs"),
            "duplex_wait_p95_us": number(after, "DuplexWaitP95Us"),
            "render_callback_p95_us": number(after, "RenderCallbackP95Us"),
        },
        "render": {
            "period_frames": number(after, "RuntimeOutputPeriodFrames"),
            "endpoint_buffer_frames": number(after, "RuntimeOutputEndpointBufferFrames"),
            "event_gap_p95_us": number(after, "RenderEventGapP95Us"),
            "event_gap_p99_us": number(after, "RenderEventGapP99Us"),
            "event_gap_max_us": number(after, "RenderEventGapMaxUs"),
        },
        "render_padding_frames": {key: number(after, f"RenderPadding{key}Frames")
                                  for key in ("P50", "P95", "P99")},
        "render_queue_frames": number(after, "RenderQueueFrames"),
        "timing_pressure_delta_frames": (number(after, "RenderTimingPressureFrames") -
                                         number(before, "RenderTimingPressureFrames")),
        "confirmed_underrun_delta_frames": (number(after, "RenderConfirmedUnderrunFrames") -
                                            number(before, "RenderConfirmedUnderrunFrames")),
        "legacy_starved_delta_frames": (number(after, "RenderStarvedFrames") -
                                        number(before, "RenderStarvedFrames")),
        "xruns_delta": number(after, "XRuns") - number(before, "XRuns"),
        "pcm_continuity": continuity,
        "classifications": causes,
        "candidate_application_overhead_ms": internal + max(0, queue_ms - period_ms),
    }
    report_prefix = f"{prefix}-{session}" if session > 1 else str(prefix)
    summary_path = Path(f"{report_prefix}-summary.json")
    report_path = Path(f"{report_prefix}-REPORT.md")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    latency = summary["latency_ms"]
    lines = [
        "# WASAPI Shared local latency report", "",
        f"Output: {endpoint.get('outputName') or 'unknown'} "
        f"({endpoint.get('outputId', 'unknown')})  ",
        f"Input: {endpoint.get('inputName') or 'unknown'} "
        f"({endpoint.get('inputId', 'unknown')})  ",
        f"Selected / requested / actual: {summary['selected_period_frames']:g} / "
        f"{summary['requested_period_frames']:g} / {actual:g} frames at {rate:g} Hz  ",
        f"Mismatch reason: {summary['period_mismatch_reason']}  ",
        f"Available periods: {capabilities.get('periodFrames', 'unknown')}  ",
        f"Minimum / fundamental / default / maximum: "
        f"{capabilities.get('minPeriodFrames', '?')} / "
        f"{capabilities.get('fundamentalPeriodFrames', '?')} / "
        f"{capabilities.get('defaultPeriodFrames', '?')} / "
        f"{capabilities.get('maxPeriodFrames', '?')} frames", "",
        "| Capture | Internal + DSP | Render queue | Output residual | Estimated total |",
        "| ---: | ---: | ---: | ---: | ---: |",
        f"| {latency['capture']:.2f} ms | {internal:.2f} ms | {queue_ms:.2f} ms | "
        f"{latency['output_residual']:.2f} ms | {latency['estimated_total']:.2f} ms |", "",
        f"Capture: selected/requested/actual "
        f"{summary['capture']['selected_period_frames']:g}/"
        f"{summary['capture']['requested_period_frames']:g}/"
        f"{summary['capture']['period_frames']:g} frames; mismatch "
        f"{summary['capture']['mismatch_reason']}; buffer "
        f"{summary['capture']['buffer_frames']:g} frames; event P95/P99 "
        f"{summary['capture']['event_gap_p95_us']:g}/"
        f"{summary['capture']['event_gap_p99_us']:g} µs; packet QPC gap P99 "
        f"{summary['capture']['packet_gap_p99_us']:g} µs; age "
        f"{summary['capture']['age_us']:g} µs; capture bursts max "
        f"{summary['capture']['packets_per_wake_max']:g} packets / "
        f"{summary['capture']['frames_per_wake_max']:g} frames.  ",
        f"Internal: clock bridge {summary['internal']['clock_bridge_latency_frames']:g} frames; "
        f"resampler/DSP {summary['internal']['resampler_dsp_ms']:.2f} ms; "
        f"duplex wait P95 {summary['internal']['duplex_wait_p95_us']:g} µs; "
        f"render callback P95 {summary['internal']['render_callback_p95_us']:g} µs.  ",
        f"ClockBridge: capacity {summary['clock_bridge']['capacity_ms']:g} ms; "
        f"target {summary['clock_bridge']['target_frames']:g} frames; "
        f"fill before pull P95 {summary['clock_bridge']['fill_before_pull_p95_frames']:g} "
        f"frames; clocks {summary['clock_bridge']['clock_relationship']}; "
        f"drift {summary['clock_bridge']['drift_ppm']:g} ppm; fill correction "
        f"{summary['clock_bridge']['fill_correction_ratio']:g}; overrun/underflow/dropped "
        f"{summary['clock_bridge']['overruns']:g}/"
        f"{summary['clock_bridge']['underruns']:g}/"
        f"{summary['clock_bridge']['dropped_frames']:g}.  ",
        f"Render: period {summary['render']['period_frames']:g}, endpoint buffer "
        f"{summary['render']['endpoint_buffer_frames']:g} frames; event P95/P99/max "
        f"{summary['render']['event_gap_p95_us']:g}/"
        f"{summary['render']['event_gap_p99_us']:g}/"
        f"{summary['render']['event_gap_max_us']:g} µs.  ",
        f"Queue: {summary['render_queue_frames']:g} frames; padding P50/P95/P99: "
        + "/".join(f"{value:g}" for value in summary["render_padding_frames"].values()) + " frames.  ",
        f"Timing pressure / confirmed underrun / legacy starvation / XRuns deltas: "
        f"{summary['timing_pressure_delta_frames']:g} / "
        f"{summary['confirmed_underrun_delta_frames']:g} / "
        f"{summary['legacy_starved_delta_frames']:g} / {summary['xruns_delta']:g}.  ",
        f"PCM continuity: {continuity['continuity_percent']}%; longest gap "
        f"{continuity['longest_pcm_gap_frames']} frames; duplicated "
        f"{continuity['duplicate_frames']} frames.  ",
        f"Classifications: {', '.join(causes)}.  ",
        f"Candidate application contribution: {summary['candidate_application_overhead_ms']:.2f} ms "
        "(internal processing plus queue above one actual period; this is not proven removable).", "",
        "Physical loopback latency was not measured. Capture/output values are software estimates; "
        "the report cannot prove a millisecond split between application and driver hardware. "
        "PCM continuity is measured before WASAPI ReleaseBuffer.",
    ]
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    archive_path = Path(f"{report_prefix}-evidence.zip")
    evidence = [endpoint_path, samples_path, continuity_path, summary_path, report_path]
    evidence += [Path(f"{stem}{suffix}") for suffix in (".csv", "-starve.csv", "-queue.csv")]
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in evidence:
            if path.exists():
                archive.write(path, arcname=path.name)
    print(report_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", type=Path)
    parser.add_argument("--session", type=int, default=1)
    args = parser.parse_args()
    make_report(args.prefix, args.session)
