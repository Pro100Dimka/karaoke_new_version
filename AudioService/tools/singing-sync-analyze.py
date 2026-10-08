"""Measure vocal markers against the backing in each client's final master PCM.

The pilot is generated at the microphone capture boundary. Its 30 ms burst repeats every
500 ms on the Room Server musical timeline. A missing backing match or vocal marker is
reported as missing evidence, never as zero skew.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import correlate, resample_poly


def pilot_template(rate: int, frequency: float, period_ms: int = 500) -> np.ndarray:
    position = np.arange(min(rate * 3 // 100, rate * period_ms // 2500), dtype=np.float64)
    envelope = np.sin(np.pi * (position + 0.5) / position.size) ** 2
    return (envelope * np.sin(2 * np.pi * frequency * position / rate)).astype(np.float32)


def backing_offset(master: np.ndarray, backing: np.ndarray, rate: int) -> tuple[float, float]:
    reduced_rate = 4_000
    music = resample_poly(backing, reduced_rate, rate).astype(np.float64)
    heard = resample_poly(master, reduced_rate, rate).astype(np.float64)
    size = min(2 * reduced_rate, len(music) // 2, len(heard) // 2)
    if size < reduced_rate:
        raise ValueError("At least one second of backing and final PCM is required")
    candidates = range(0, min(len(heard) - size + 1, 12 * reduced_rate), reduced_rate)
    begin = max(candidates, key=lambda index: np.sum(heard[index:index + size] ** 2))
    segment = heard[begin:begin + size]
    positions = correlate(music, segment, mode="valid", method="fft")
    squares = np.concatenate(([0.0], np.cumsum(music * music)))
    energy = np.maximum(0.0, squares[size:] - squares[:-size])
    confidence = np.abs(positions) / np.sqrt(energy * np.sum(segment * segment) + 1e-12)
    best = int(np.argmax(confidence))
    return (best - begin) / reduced_rate, float(confidence[best])


def _summary(samples: dict[int, float], expected_beats: list[int], period_ms: float) -> dict:
    expected = len(expected_beats)
    missing = sorted(set(expected_beats) - samples.keys())
    longest_run = run = 0
    previous = None
    for beat in missing:
        run = run + 1 if previous is not None and beat == previous + 1 else 1
        longest_run = max(longest_run, run)
        previous = beat
    values = np.abs(list(samples.values()))
    reliable = len(samples) >= max(3, (expected + 3) // 4)
    return {
        "expected": expected,
        "detected": len(samples),
        "reliable": reliable,
        "p50Ms": float(np.percentile(values, 50)) if reliable else None,
        "p95Ms": float(np.percentile(values, 95)) if reliable else None,
        "p99Ms": float(np.percentile(values, 99)) if reliable else None,
        "maxMs": float(values.max()) if reliable else None,
        "signedMedianMs": float(np.median(list(samples.values()))) if reliable else None,
        "missingBeats": missing,
        "longestMissingRunMs": longest_run * period_ms,
    }


def analyze_mix(master: np.ndarray, backing: np.ndarray, rate: int,
                own_frequency: float, remote_frequency: float,
                own_intervals: list[tuple[float, float]] | None = None,
                remote_intervals: list[tuple[float, float]] | None = None,
                period_ms: int = 500, expected_skew_ms: float | None = None) -> dict:
    offset, correlation = backing_offset(master, backing, rate)
    if correlation < 0.2:
        raise ValueError(f"Final PCM backing cannot be located (correlation={correlation:.3f})")
    offset_frames = round(offset * rate)
    residual = np.asarray(master, dtype=np.float32).copy()
    first = max(0, -offset_frames)
    last = min(len(residual), len(backing) - offset_frames)
    if last > first:
        heard = residual[first:last]
        reference = backing[first + offset_frames:last + offset_frames]
        gain = float(np.dot(heard[:rate * 8], reference[:rate * 8]) /
                     max(1e-12, np.dot(reference[:rate * 8], reference[:rate * 8])))
        residual[first:last] -= gain * reference

    period = rate * period_ms // 1000
    marker_frames = len(pilot_template(rate, own_frequency, period_ms))
    margin = max(period * 0.4, rate * 0.2 if expected_skew_ms is not None else 0)
    beats = [beat for beat in range(1, len(backing) // period)
             if beat * period - offset_frames - margin >= 0 and
             beat * period - offset_frames + margin + marker_frames <= len(residual)]

    def active_beats(intervals: list[tuple[float, float]] | None) -> list[int]:
        return beats if intervals is None else [beat for beat in beats
                                                if any(start <= beat * period / rate < end
                                                       for start, end in intervals)]

    def locate(frequency: float, expected_beats: list[int],
               intervals: list[tuple[float, float]] | None) -> dict[int, float]:
        template = pilot_template(rate, frequency, period_ms)
        energy = float(np.dot(template, template))
        def candidate(beat: int) -> tuple[float, float, float, float]:
            expected = beat * period - offset_frames
            window = rate * 0.04 if expected_skew_ms is not None else period * 0.4
            center = rate * expected_skew_ms / 1000 if expected_skew_ms is not None else 0
            lo = round(expected + center - window)
            hi = round(expected + center + window) + len(template)
            matches = correlate(residual[lo:hi], template, mode="valid", method="fft")
            # A server-returned marker belongs to this beat only within the fixed
            # room playout window. Searching adjacent beats also admits music/DSP
            # transients with plausible pilot frequencies.
            search_start = round(window - rate * 0.012) if expected_skew_ms is not None else round(period * 0.4 - rate * 0.01)
            search_end = round(window + rate * 0.012) if expected_skew_ms is not None else round(period * 0.4 + rate * 0.11)
            peak = search_start + int(np.argmax(matches[search_start:search_end]))
            amplitude = float(matches[peak] / energy)
            selected = residual[lo + peak:lo + peak + len(template)]
            similarity = float(matches[peak] /
                               np.sqrt(energy * np.dot(selected, selected) + 1e-12))
            dominance = float("inf")
            if expected_skew_ms is None:
                side_distance = round(rate * 0.07)
                side_width = round(rate * 0.003)
                side = max(float(np.max(np.abs(matches[max(0, index - side_width):
                                                        min(len(matches), index + side_width + 1)])))
                           for index in (peak - side_distance, peak + side_distance)
                           if 0 <= index < len(matches))
                dominance = float(matches[peak] / max(side, 1e-12))
            return (lo + peak - expected) * 1000 / rate, amplitude, similarity, dominance

        expected_set = set(expected_beats)
        inactive = ([beat for beat in beats if beat not in expected_set and
                     all(abs(beat * period / rate - edge) > 1.0
                         for interval in intervals for edge in interval)]
                    if intervals is not None else [])
        background = ([candidate(beat)[1] for beat in inactive]
                      if expected_skew_ms is not None and len(inactive) >= 10 else [])
        threshold = max(0.02, 2 * float(np.percentile(background, 80))) if background else 0.02
        found = {}
        for beat in expected_beats:
            delay, amplitude, similarity, dominance = candidate(beat)
            if amplitude > threshold and similarity > 0.15 and dominance > 1.2:
                found[beat] = delay
        return found

    own_beats = active_beats(own_intervals)
    remote_beats = active_beats(remote_intervals)
    own = locate(own_frequency, own_beats, own_intervals)
    remote = locate(remote_frequency, remote_beats, remote_intervals)
    return {
        "backingOffsetMs": offset * 1000,
        "backingCorrelation": correlation,
        "own": _summary(own, own_beats, period * 1000 / rate),
        "remote": _summary(remote, remote_beats, period * 1000 / rate),
        "vocalToVocal": _summary({beat: remote[beat] - own[beat]
                                   for beat in own.keys() & remote.keys()},
                                  sorted(set(own_beats) & set(remote_beats)), period * 1000 / rate),
        "markers": {"own": own, "remote": remote},
    }


def _mono(path: Path) -> tuple[np.ndarray, int]:
    samples, rate = sf.read(path, always_2d=True, dtype="float32")
    return samples.mean(axis=1), rate


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--a", type=Path, required=True, help="what-A-hears.wav")
    parser.add_argument("--b", type=Path, required=True, help="what-B-hears.wav")
    parser.add_argument("--backing", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--gate", type=Path,
                        help="Physical gate JSON with actual A-only, B-only and A+B transition times")
    args = parser.parse_args()
    backing, backing_rate = _mono(args.backing)
    intervals = {0: None, 1: None}
    gate = None
    if args.gate:
        gate = json.loads(args.gate.read_text(encoding="utf-8"))
        phases = gate["phases"]
        if len(phases) != 3:
            raise ValueError("Three recorded vocal phases are required")
        end_ms = max(90_000, gate["samples"][-1]["serverElapsedMs"])
        intervals = {index: [(max(0, phase["serverElapsedMs"] + 750) / 1000,
                              (phases[at + 1]["serverElapsedMs"] if at + 1 < len(phases)
                               else end_ms) / 1000 - 0.75)
                             for at, phase in enumerate(phases) if phase["gains"][index] > 0]
                     for index in (0, 1)}
    result = {}
    for label, wav, own, remote, own_index in (("A_hears_B", args.a, 697.0, 941.0, 0),
                                               ("B_hears_A", args.b, 941.0, 697.0, 1)):
        master, rate = _mono(wav)
        music = resample_poly(backing, rate, backing_rate) if rate != backing_rate else backing
        marker_period = gate.get("markerPeriodMs", 500) if gate else 500
        room_delay = (int(gate["samples"][0]["host" if own_index == 0 else "pc2"]
                          ["RoomPlayoutDelayFrames"]) * 1000 / rate
                      if gate and marker_period != 500 else None)
        result[label] = analyze_mix(master, music, rate, own, remote,
                                    intervals[own_index], intervals[1 - own_index],
                                    marker_period, room_delay)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: {field: ({name: value[name] for name in
                                     ("expected", "detected", "reliable", "p50Ms", "p95Ms",
                                      "p99Ms", "maxMs", "signedMedianMs", "longestMissingRunMs")}
                                     if field in ("own", "remote", "vocalToVocal") else value)
                             for field, value in item.items() if field != "markers"}
                      for key, item in result.items()}, indent=2))


if __name__ == "__main__":
    main()
