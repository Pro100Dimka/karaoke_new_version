"""Generate coded stereo PCM and inspect a bounded WASAPI pre-submit capture."""

import argparse
import csv
import json
from pathlib import Path
import wave

import numpy as np


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
    if samples.ndim != 2 or samples.shape[1] < 2 or gain <= 0:
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
    missing = int(np.maximum(differences - 1, 0).sum())
    largest_missing = int(np.maximum(differences - 1, 0).max(initial=0))
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
    return {
        "captured_frames": int(len(samples)),
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
        "potential_audible_sized_gaps": int(np.count_nonzero(zero_lengths >= rate // 1000) +
                                             np.count_nonzero(differences - 1 >= rate // 1000)),
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
    if sample_format == "Float32":
        raw = np.memmap(path, dtype='<f4', mode='r')
        values = raw
    elif sample_format == "Int16":
        raw = np.memmap(path, dtype='<i2', mode='r')
        values = raw.astype(np.float32) / 32768.0
    elif sample_format == "Int32":
        raw = np.memmap(path, dtype='<i4', mode='r')
        values = raw.astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"unsupported native capture format: {sample_format}")
    return np.asarray(values).reshape(-1, channels)


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
    args = parser.parse_args()
    if args.command == "generate":
        generate(args.path, args.seconds, args.rate)
        return
    stem = Path(str(args.prefix) + f"-{args.session}")
    metadata = read_metadata(Path(str(stem) + ".csv"))
    samples = read_capture(Path(str(stem) + ".pcm"), metadata)
    rate = int(metadata["sampleRate"])
    source_frames = args.source_seconds * rate
    active, leading = trim_to_signal(samples)
    if args.gain:
        gain, source_offset = args.gain, 0
    else:
        gain, _, source_offset = estimate_gain(samples, source_frames)
    events = read_rows(Path(str(stem) + "-starve.csv"))
    for event in events:
        event["capturedFrames"] = int(event["capturedFrames"]) - leading
    queue_path = Path(str(stem) + "-queue.csv")
    queue_events = read_rows(queue_path) if queue_path.exists() else []
    for event in queue_events:
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
