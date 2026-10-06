"""Classify one isolated WASAPI Shared PCM run and pack a portable report."""

import argparse
import json
from pathlib import Path
import zipfile


def number(values, key):
    try:
        return float(values.get(key, 0))
    except (TypeError, ValueError):
        return 0.0


def classify(after, before, capabilities):
    rate = number(after, "RuntimeOutputSampleRate")
    actual = number(after, "SharedEnginePeriodActualFrames")
    minimum = number(after, "SharedEnginePeriodMinimumFrames") or number(capabilities, "minPeriodFrames")
    period_ms = 1000 * actual / rate if rate else 0
    minimum_ms = 1000 * minimum / rate if rate else 0
    queue = number(after, "RenderQueueFrames")
    internal = number(after, "LocalAudioServiceInternalMs") + number(after, "LocalResamplerDspMs")
    causes = []
    conditions = [
        (minimum_ms >= 10, "PERIOD_MINIMUM_HIGH"),
        (after.get("SharedEnginePeriodFallback") == "ENGINE_PERIODICITY_LOCKED" or
         after.get("PeriodMismatchReason") == "ENGINE_PERIODICITY_LOCKED", "PERIOD_LOCKED"),
        (number(after, "LocalCaptureDeviceMs") >= 15, "CAPTURE_LATENCY_HIGH"),
        (internal >= 5, "INTERNAL_LATENCY_HIGH"),
        (actual > 0 and queue > 1.5 * actual, "RENDER_QUEUE_HIGH"),
        (number(after, "LocalEndpointOutputMs") >= 15, "OUTPUT_LATENCY_HIGH"),
        (number(after, "RenderTimingPressureFrames") > number(before, "RenderTimingPressureFrames"),
         "TIMING_PRESSURE"),
        (number(after, "RenderConfirmedUnderrunFrames") >
         number(before, "RenderConfirmedUnderrunFrames"), "CONFIRMED_UNDERRUN"),
        (after.get("PeriodMismatchReason") == "FORMAT_NEGOTIATION" or
         (number(after, "RequestedSampleRate") > 0 and rate > 0 and
          number(after, "RequestedSampleRate") != rate), "FORMAT_FALLBACK"),
        ((minimum_ms >= 10 or number(after, "LocalEndpointOutputMs") >= 15) and
         internal < 5 and not (actual > 0 and queue > 1.5 * actual),
         "DRIVER_OR_WINDOWS_LIMITED"),
    ]
    causes.extend(label for condition, label in conditions if condition)
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
            "period_frames": number(after, "RuntimeInputPeriodFrames"),
            "buffer_frames": number(after, "RuntimeInputEndpointBufferFrames"),
            "event_gap_p95_us": number(after, "CaptureEventGapP95Us"),
            "event_gap_p99_us": number(after, "CaptureEventGapP99Us"),
            "age_us": number(after, "CaptureAgeUs"),
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
    summary_path = Path(f"{prefix}-summary.json")
    report_path = Path(f"{prefix}-REPORT.md")
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
        f"Capture: period {summary['capture']['period_frames']:g}, buffer "
        f"{summary['capture']['buffer_frames']:g} frames; event P95/P99 "
        f"{summary['capture']['event_gap_p95_us']:g}/"
        f"{summary['capture']['event_gap_p99_us']:g} µs; age "
        f"{summary['capture']['age_us']:g} µs.  ",
        f"Internal: clock bridge {summary['internal']['clock_bridge_latency_frames']:g} frames; "
        f"resampler/DSP {summary['internal']['resampler_dsp_ms']:.2f} ms; "
        f"duplex wait P95 {summary['internal']['duplex_wait_p95_us']:g} µs; "
        f"render callback P95 {summary['internal']['render_callback_p95_us']:g} µs.  ",
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
    archive_path = Path(f"{prefix}-evidence.zip")
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
