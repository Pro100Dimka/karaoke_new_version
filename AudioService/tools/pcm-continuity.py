"""Generate coded stereo PCM and inspect a bounded WASAPI pre-submit capture."""

import argparse
import csv
import json
import math
import shutil
import wave
from math import gcd
from pathlib import Path

import numpy as np


def analyze_reference(reference, observed, rate, reference_rate=None):
    """Compare captured PCM with a known post-DSP reference; gain and delay are free.

    This is a signal oracle, not a proof of acoustic output quality. A reference must
    describe the permitted DSP and mix; an unknown microphone makes the result
    inconclusive instead of being treated as silence.
    """
    source = np.asarray(reference, dtype=np.float64)
    capture = np.asarray(observed, dtype=np.float64)
    if source.ndim == 2:
        source = source.mean(axis=1)
    if capture.ndim == 2:
        capture = capture.mean(axis=1)
    if source.ndim != 1 or capture.ndim != 1 or rate <= 0:
        raise ValueError("reference and capture must be mono or interleaved PCM")
    if reference_rate is not None and reference_rate != rate:
        from scipy.signal import resample_poly
        divisor = gcd(reference_rate, rate)
        source = resample_poly(source, rate // divisor, reference_rate // divisor)
    result = {"status": "INCONCLUSIVE", "reason": "insufficient reference or capture",
              "defects": [], "sample_rate": rate, "alignment_frames": None}
    if (len(source) < rate // 10 or len(capture) < rate // 10 or
            not np.isfinite(source).all() or not np.isfinite(capture).all() or
            np.sqrt(np.mean(source ** 2)) < 0.01):
        return result

    from scipy.signal import correlate
    # The reported offset is in capture frames. Correlate only the beginning so
    # drift later in a run cannot move the entire comparison window.
    probe = source[:min(len(source), rate // 2)]
    match = correlate(capture[:min(len(capture), len(probe) + rate // 2)],
                      probe, mode="full", method="fft")
    lags = np.arange(-len(probe) + 1, len(match) - len(probe) + 1)
    allowed = (lags >= -rate // 2) & (lags <= rate // 2)
    offset = int(lags[allowed][np.argmax(np.abs(match[allowed]))])
    source_start, capture_start = max(0, -offset), max(0, offset)
    common = min(len(source) - source_start, len(capture) - capture_start)
    if common < rate // 10:
        result["reason"] = "too little aligned signal"
        return result
    expected = source[source_start:source_start + common]
    actual = capture[capture_start:capture_start + common]
    gain = float(np.dot(expected, actual) / np.dot(expected, expected))
    if not np.isfinite(gain) or abs(gain) < 1e-4:
        result["reason"] = "no correlated output; capture or routing unavailable"
        return result
    residual = actual - gain * expected
    residual_rms = float(np.sqrt(np.mean(residual ** 2)))
    signal_rms = float(np.sqrt(np.mean((gain * expected) ** 2)))
    result.update({"reason": None, "alignment_frames": offset, "gain": gain,
                   "compared_frames": common, "residual_rms": residual_rms,
                   "residual_to_signal": residual_rms / signal_rms})

    def defect(kind, start, end, detail):
        frame = max(0, source_start + int(start))
        result["defects"].append({"kind": kind, "start_frame": frame,
                                  "end_frame": source_start + int(end),
                                  "start_seconds": round(frame / rate, 6),
                                  "detail": detail})

    # Real clipping is a plateau at the digital rail; a single legitimate peak
    # or a gain below unity is not enough evidence.
    if np.count_nonzero(np.abs(actual) >= 0.999) >= 8:
        positions = np.flatnonzero(np.abs(actual) >= 0.999)
        defect("clipping", positions[0], positions[-1] + 1,
               f"{len(positions)} samples at the digital rail")

    window = max(16, rate // 1000)
    kernel = np.ones(window) / window
    source_power = np.convolve(expected ** 2, kernel, mode="same")
    capture_power = np.convolve(actual ** 2, kernel, mode="same")
    silent = (source_power > 0.01 ** 2) & (capture_power < 0.002 ** 2)
    edges = np.diff(np.r_[False, silent, False].astype(np.int8))
    for start, end in zip(np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)):
        if end - start >= window:
            defect("dropout", start, end, "reference active while output is silent")

    # Exact repeated runs identify duplicated frames without interpreting a
    # naturally periodic tone as a duplicate: the reference must differ there.
    seen = {}
    for at in range(0, common - 128, 8):
        key = actual[at:at + 32].tobytes()
        prior = seen.get(key)
        if (prior is not None and at - prior >= 32 and
                np.array_equal(actual[at:at + 128], actual[prior:prior + 128]) and
                np.max(np.abs(residual[at:at + 128])) > 0.01):
            defect("duplicate", at, at + 128, f"128 frames repeat position {prior}")
            break
        seen[key] = at

    impulsive = np.flatnonzero(np.abs(residual) > max(0.12, 8 * residual_rms))
    for at in impulsive:
        if (at == 0 or np.abs(residual[at - 1]) <= 0.12) and (
                at + 1 == common or np.abs(residual[at + 1]) <= 0.12):
            defect("click", at, at + 1, "isolated high residual sample")
            break

    if result["defects"]:
        result["status"] = "FAIL"
        return result

    if residual_rms > max(0.001, 0.004 * signal_rms):
        # Residual aligned to the orthogonal cubic component is deterministic
        # nonlinearity. Uncorrelated sustained residual is reported as noise.
        cubic = expected ** 3
        cubic -= expected * (np.dot(cubic, expected) / np.dot(expected, expected))
        correlation = abs(float(np.dot(residual, cubic))) / max(
            1e-12, float(np.linalg.norm(residual) * np.linalg.norm(cubic)))
        kind = "distortion" if correlation > 0.8 else "noise"
        defect(kind, 0, common, f"residual rms {residual_rms:.6f}; cubic correlation {correlation:.3f}")

    if residual_rms > 0.001:
        # Local offsets reveal drift even when a global alignment masks the
        # beginning or end. The chirped test signal avoids periodic ambiguity.
        block, hop = min(rate // 5, common // 3), max(1, rate // 10)
        if block >= 2048:
            local_lags = []
            for start in range(0, common - block + 1, hop):
                margin = min(256, start, common - start - block)
                if margin < 16:
                    continue
                reference_window = expected[start:start + block]
                capture_window = actual[start - margin:start + block + margin]
                local = correlate(capture_window, reference_window,
                                  mode="valid", method="fft")
                local_lags.append(int(np.argmax(np.abs(local))) - margin)
            if len(local_lags) >= 3 and max(local_lags) - min(local_lags) >= 24:
                defect("timing_drift", 0, common,
                       f"local lag span {max(local_lags) - min(local_lags)} frames")

    result["status"] = "FAIL" if result["defects"] else "PASS"
    return result

MULTIPLIER = 1664525
INCREMENT = 1013904223
INVERSE = pow(MULTIPLIER, -1, 1 << 32)


def encode_frames(indices):
    values = np.asarray(indices, dtype=np.uint32)
    codes = values * np.uint32(MULTIPLIER) + np.uint32(INCREMENT)
    low = (codes & np.uint32(0xFFFF)).astype(np.uint16).view(np.int16)
    high = (codes >> np.uint32(16)).astype(np.uint16).view(np.int16)
    return np.stack((low, high), axis=-1).astype(np.float32) / 32768.0


def analyze_samples(samples, source_frames, gain, starve_events=(),
                    correlation_window_frames=128, rate=48000, queue_events=()):
    samples = np.asarray(samples, dtype=np.float32)
    if (
        samples.ndim != 2
        or samples.shape[1] < 2
        or not math.isfinite(gain)
        or gain <= 0
    ):
        raise ValueError("coded PCM requires two channels and a positive gain")
    stereo = samples[:, :2]
    zero = np.all(np.abs(stereo) < 1e-9, axis=1)
    quantized = np.clip(np.rint(stereo / gain * 32768.0), -32768, 32767).astype(np.int16)
    low = quantized[:, 0].view(np.uint16).astype(np.uint32)
    high = quantized[:, 1].view(np.uint16).astype(np.uint32)
    codes = low | (high << np.uint32(16))
    decoded = (codes - np.uint32(INCREMENT)) * np.uint32(INVERSE)
    residual = np.max(np.abs(encode_frames(decoded) * gain - stereo), axis=1)
    valid = ~zero & (decoded < source_frames) & (residual <= gain * 1.5 / 32768.0)
    valid_offsets = np.flatnonzero(valid)
    positions = decoded[valid].astype(np.int64)
    differences = np.diff(positions)
    frame_gaps = np.maximum(differences - 1, 0)
    missing = int(frame_gaps.sum())
    largest_missing = int(frame_gaps.max(initial=0))
    prior_max = np.maximum.accumulate(positions)
    duplicate = int(np.count_nonzero(positions[1:] <= prior_max[:-1]))
    repeated = int(np.count_nonzero(differences < 0))
    zero_edges = np.diff(np.r_[False, zero, False].astype(np.int8))
    zero_starts = np.flatnonzero(zero_edges == 1)
    zero_ends = np.flatnonzero(zero_edges == -1)
    zero_lengths = zero_ends - zero_starts
    longest_zero = int(zero_lengths.max(initial=0))
    invalid = ~valid & ~zero
    span = int(positions.max() - positions.min() + 1) if positions.size else 0
    errors = missing + duplicate + int(np.count_nonzero(invalid))
    continuity = max(0.0, 100.0 * (1.0 - errors / span)) if span else 0.0
    anomaly = zero | invalid
    if valid_offsets.size > 1:
        anomaly[valid_offsets[1:][differences != 1]] = True
    anomaly_offsets = np.flatnonzero(anomaly)
    def has_gap(event):
        at = int(event["capturedFrames"])
        index = np.searchsorted(anomaly_offsets, at)
        nearest = min((abs(int(anomaly_offsets[candidate]) - at)
                       for candidate in (index - 1, index)
                       if 0 <= candidate < anomaly_offsets.size), default=float("inf"))
        return nearest <= correlation_window_frames
    correlated = sum(has_gap(event) for event in starve_events)
    queue_correlations = [
        {"captured_frame": int(event["capturedFrames"]), "reason": event["reason"],
         "pcm_gap": bool(has_gap(event))} for event in queue_events
    ]
    queue_gaps = sum(event["pcm_gap"] for event in queue_correlations)
    audible_gap_frames = rate // 1000
    return {
        "captured_frames": len(samples),
        "decoded_frames": int(valid.sum()),
        "missing_frames": missing,
        "duplicate_frames": duplicate,
        "repeated_sequences": repeated,
        "zero_gap_frames": int(zero.sum()),
        "longest_zero_gap_frames": longest_zero,
        "longest_pcm_gap_frames": max(longest_zero, largest_missing),
        "invalid_nonzero_frames": int(invalid.sum()),
        "continuity_percent": round(continuity, 6),
        "maximum_discontinuity_frames": int(np.abs(differences - 1).max(initial=0)),
        "potential_audible_sized_gaps": int(
            np.count_nonzero(zero_lengths >= audible_gap_frames)
            + np.count_nonzero(differences - 1 >= audible_gap_frames)
        ),
        "starvation_windows": len(starve_events),
        "starvation_windows_with_pcm_gap": int(correlated),
        "starvation_windows_without_pcm_gap": int(len(starve_events) - correlated),
        "queue_changes": len(queue_events),
        "queue_changes_with_pcm_gap": int(queue_gaps),
        "queue_changes_without_pcm_gap": int(len(queue_events) - queue_gaps),
        "queue_change_correlations": queue_correlations,
    }


def generate(path, seconds, rate):
    total = int(seconds * rate)
    if total <= 0 or total >= 1 << 32:
        raise ValueError("duration must contain between 1 and 2^32-1 frames")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(rate)
        for start in range(0, total, rate):
            count = min(rate, total - start)
            samples = np.rint(encode_frames(np.arange(start, start + count,
                                                      dtype=np.uint32)) * 32768).astype('<i2')
            output.writeframesraw(samples.tobytes())
        output.writeframes(b"")


def read_capture(path, metadata):
    channels = int(metadata["channels"])
    sample_format = metadata["format"]
    formats = {
        "Float32": ("<f4", None),
        "Int16": ("<i2", 32768.0),
        "Int32": ("<i4", 2147483648.0),
    }
    if sample_format not in formats:
        raise ValueError(f"unsupported native capture format: {sample_format}")
    dtype, scale = formats[sample_format]
    values = np.asarray(np.memmap(path, dtype=dtype, mode="r"))
    if scale is not None:
        values = values.astype(np.float32) / scale
    return values.reshape(-1, channels)


def read_wav(path):
    with wave.open(str(path), "rb") as source:
        channels, width, rate = (source.getnchannels(), source.getsampwidth(),
                                 source.getframerate())
        data = source.readframes(source.getnframes())
    if width == 2:
        samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        samples = np.frombuffer(data, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise ValueError("reference comparison supports 16-bit and 32-bit PCM WAV")
    return samples.reshape(-1, channels), rate


def compare_wavs(reference_path, capture_path, output_dir):
    reference, reference_rate = read_wav(reference_path)
    capture, capture_rate = read_wav(capture_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(reference_path, output_dir / "reference.wav")
    shutil.copy2(capture_path, output_dir / "capture.wav")
    report = analyze_reference(reference, capture, capture_rate, reference_rate)
    report["reference_sample_rate"] = reference_rate
    report["capture_sample_rate"] = capture_rate
    for index, item in enumerate(report["defects"]):
        offset = report["alignment_frames"] or 0
        start = max(0, item["start_frame"] + offset - capture_rate // 10)
        end = min(len(capture), item["end_frame"] + offset + capture_rate // 10)
        excerpt = output_dir / f"defect-{index + 1:03d}-{item['kind']}.wav"
        with wave.open(str(excerpt), "wb") as output:
            output.setnchannels(capture.shape[1])
            output.setsampwidth(2)
            output.setframerate(capture_rate)
            output.writeframes((np.clip(capture[start:end], -1, 1) * 32767)
                               .astype("<i2").tobytes())
        item["excerpt"] = excerpt.name
    target = output_dir / "report.json"
    target.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def calibrate(target):
    """Measure detector errors on fixed synthetic, labelled PCM corruptions."""
    rate = 48000
    frames = np.arange(rate, dtype=np.float64)
    source = (0.65 * np.sin(2 * np.pi * (197 * frames / rate
              + 17 * (frames / rate) ** 2))).astype(np.float32)
    rng = np.random.default_rng(12345)
    click = source.copy()
    click[15000] = 0.95
    dropout = source.copy()
    dropout[20000:20500] = 0
    duplicate = source.copy()
    duplicate[25000:25400] = source[24600:25000]
    cases = [
        ("clean", source),
        ("clean_gain_delay", np.r_[np.zeros(137, dtype=np.float32), source * 0.6]),
        ("click", click),
        ("dropout", dropout),
        ("duplicate", duplicate),
        ("clipping", np.clip(source * 2, -1, 1)),
        ("noise", source + rng.normal(0, 0.025, len(source))),
        ("distortion", source + 0.08 * source ** 3),
        ("timing_drift", source[np.minimum((frames * 1.003).astype(int), rate - 1)]),
    ]
    rows = []
    for label, capture in cases:
        result = analyze_reference(source, capture, rate)
        kinds = {item["kind"] for item in result["defects"]}
        rows.append({"label": label, "status": result["status"],
                     "detected": sorted(kinds),
                     "correct": result["status"] == "PASS" if label.startswith("clean")
                     else label in kinds})
    report = {"seed": 12345, "sample_rate": rate, "clean_cases": 2,
              "damaged_cases": len(rows) - 2,
              "false_positives": sum(not row["correct"] for row in rows[:2]),
              "missed_defects": sum(not row["correct"] for row in rows[2:]),
              "cases": rows,
              "scope": "synthetic mono PCM only; no hardware or unknown DSP"}
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def read_metadata(path):
    with open(path, encoding="utf-8") as source:
        first = source.readline().removeprefix("#").strip()
    return dict(field.split("=", 1) for field in first.split(","))


def read_rows(path):
    with open(path, newline="", encoding="utf-8") as source:
        return list(csv.DictReader(row for row in source if not row.startswith("#")))


def trim_to_signal(samples):
    nonzero = np.flatnonzero(np.any(np.abs(samples[:, :2]) > 1e-9, axis=1))
    if nonzero.size == 0:
        raise ValueError("capture contains no sounding PCM")
    return samples[nonzero[0]:nonzero[-1] + 1], int(nonzero[0])


def estimate_gain(samples, source_frames):
    active, leading = trim_to_signal(samples)
    if len(active) < 2048:
        raise ValueError("capture contains too little sounding PCM")
    observed = np.asarray(active[:2048, :2], dtype=np.float64)
    expected = encode_frames(np.arange(min(source_frames, 48000), dtype=np.uint32))
    reference = expected[:len(observed)].astype(np.float64)
    similarity = float(np.sum(reference * observed) /
                       np.sqrt(np.sum(reference * reference) * np.sum(observed * observed)))
    if similarity > 0.99:
        offset = 0
    else:
        from scipy.signal import correlate
        match = sum(correlate(expected[:, channel], observed[:, channel],
                              mode="valid", method="fft") for channel in range(2))
        offset = int(np.argmax(np.abs(match)))
    reference = expected[offset:offset + len(observed)].astype(np.float64)
    gain = float(np.sum(reference * observed) / np.sum(reference * reference))
    if gain <= 0:
        raise ValueError("could not align the coded source with the capture")
    return gain, leading, offset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("generate")
    make.add_argument("path", type=Path)
    make.add_argument("--seconds", type=int, default=360)
    make.add_argument("--rate", type=int, default=48000)
    analyze = sub.add_parser("analyze")
    analyze.add_argument("prefix", type=Path, help="capture path without -N extension")
    analyze.add_argument("--session", type=int, required=True)
    analyze.add_argument("--source-seconds", type=int, default=360)
    analyze.add_argument("--gain", type=float)
    compare = sub.add_parser("compare", help="compare a captured WAV with a post-DSP reference")
    compare.add_argument("reference", type=Path)
    compare.add_argument("capture", type=Path)
    compare.add_argument("output_dir", type=Path)
    calibration = sub.add_parser("calibrate", help="measure labelled synthetic detector errors")
    calibration.add_argument("report", type=Path)
    args = parser.parse_args()
    if args.command == "generate":
        generate(args.path, args.seconds, args.rate)
        return
    if args.command == "compare":
        result = compare_wavs(args.reference, args.capture, args.output_dir)
        print(args.output_dir / "report.json")
        raise SystemExit({"PASS": 0, "FAIL": 1, "INCONCLUSIVE": 3}[result["status"]])
    if args.command == "calibrate":
        result = calibrate(args.report)
        print(args.report)
        raise SystemExit(0 if result["false_positives"] == result["missed_defects"] == 0 else 1)
    if args.gain is not None and (not math.isfinite(args.gain) or args.gain <= 0):
        parser.error("--gain must be a finite positive number")
    stem = Path(str(args.prefix) + f"-{args.session}")
    metadata = read_metadata(Path(str(stem) + ".csv"))
    samples = read_capture(Path(str(stem) + ".pcm"), metadata)
    rate = int(metadata["sampleRate"])
    source_frames = args.source_seconds * rate
    active, leading = trim_to_signal(samples)
    if args.gain is not None:
        gain, source_offset = args.gain, 0
    else:
        gain, _, source_offset = estimate_gain(samples, source_frames)
    events = read_rows(Path(str(stem) + "-starve.csv"))
    queue_path = Path(str(stem) + "-queue.csv")
    queue_events = read_rows(queue_path) if queue_path.exists() else []
    for event in events + queue_events:
        event["capturedFrames"] = int(event["capturedFrames"]) - leading
    result = analyze_samples(active, source_frames, gain, events,
                             rate=rate, correlation_window_frames=2 * int(metadata["period"]),
                             queue_events=queue_events)
    result.update({"gain": gain, "leading_silent_frames": leading,
                   "source_start_offset": source_offset, "sample_rate": rate,
                   "actual_period_frames": int(metadata["period"])})
    target = Path(str(stem) + "-continuity.json")
    target.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(target)


if __name__ == "__main__":
    main()
