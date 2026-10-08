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


def pilot_template(rate: int, frequency: float) -> np.ndarray:
    position = np.arange(rate * 3 // 100, dtype=np.float64)
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


def _summary(samples: list[float], expected: int) -> dict:
    values = np.abs(samples)
    reliable = len(samples) >= max(3, (expected + 3) // 4)
    return {
        "expected": expected,
        "detected": len(samples),
        "reliable": reliable,
        "p50Ms": float(np.percentile(values, 50)) if reliable else None,
        "p95Ms": float(np.percentile(values, 95)) if reliable else None,
        "p99Ms": float(np.percentile(values, 99)) if reliable else None,
        "maxMs": float(values.max()) if reliable else None,
        "signedMedianMs": float(np.median(samples)) if reliable else None,
    }


def analyze_mix(master: np.ndarray, backing: np.ndarray, rate: int,
                own_frequency: float, remote_frequency: float) -> dict:
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

    period = rate // 2
    marker_frames = len(pilot_template(rate, own_frequency))
    beats = [beat for beat in range(1, len(backing) // period)
             if beat * period - offset_frames - period * 0.4 >= 0 and
             beat * period - offset_frames + period * 0.4 + marker_frames <= len(residual)]

    def locate(frequency: float) -> dict[int, float]:
        template = pilot_template(rate, frequency)
        energy = float(np.dot(template, template))
        found = {}
        for beat in beats:
            expected = beat * period - offset_frames
            lo = round(expected - period * 0.4)
            hi = round(expected + period * 0.4) + len(template)
            matches = correlate(residual[lo:hi], template, mode="valid", method="fft")
            peak = int(np.argmax(matches))
            amplitude = float(matches[peak] / energy)
            selected = residual[lo + peak:lo + peak + len(template)]
            similarity = float(matches[peak] /
                               np.sqrt(energy * np.dot(selected, selected) + 1e-12))
            side_distance = round(rate * 0.07)
            side_width = round(rate * 0.003)
            side = max(float(np.max(np.abs(matches[max(0, index - side_width):
                                                    min(len(matches), index + side_width + 1)])))
                       for index in (peak - side_distance, peak + side_distance)
                       if 0 <= index < len(matches))
            if amplitude > 0.02 and similarity > 0.4 and matches[peak] > 1.5 * side:
                found[beat] = (lo + peak - expected) * 1000 / rate
        return found

    own = locate(own_frequency)
    remote = locate(remote_frequency)
    paired = [remote[beat] - own[beat] for beat in own.keys() & remote.keys()]
    return {
        "backingOffsetMs": offset * 1000,
        "backingCorrelation": correlation,
        "own": _summary(list(own.values()), len(beats)),
        "remote": _summary(list(remote.values()), len(beats)),
        "vocalToVocal": _summary(paired, len(beats)),
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
    args = parser.parse_args()
    backing, backing_rate = _mono(args.backing)
    result = {}
    for label, wav, own, remote in (("A_hears_B", args.a, 697.0, 941.0),
                                    ("B_hears_A", args.b, 941.0, 697.0)):
        master, rate = _mono(wav)
        music = resample_poly(backing, rate, backing_rate) if rate != backing_rate else backing
        result[label] = analyze_mix(master, music, rate, own, remote)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: {field: value for field, value in item.items() if field != "markers"}
                      for key, item in result.items()}, indent=2))


if __name__ == "__main__":
    main()
