"""Remote vocal versus local backing inside ONE receiver output (method of TEST_PLAN.md).

usage: python analyze.py <receiver-master.wav> <instrumental.wav> <reference-vocal.wav> <out.json>
"""
import json
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, resample_poly, sosfiltfilt

ANALYSIS_RATE = 8_000


def mono(path):
    data, rate = sf.read(path, dtype="float64", always_2d=True)
    data = data.mean(axis=1)
    return resample_poly(data, ANALYSIS_RATE, rate) if rate != ANALYSIS_RATE else data


def peak(values, index):
    """Sub-sample position of a correlation maximum (parabolic interpolation)."""
    if 0 < index < len(values) - 1:
        a, b, c = values[index - 1], values[index], values[index + 1]
        denominator = a - 2 * b + c
        if denominator != 0:
            return index + 0.5 * (a - c) / denominator
    return float(index)


def locate(segment, reference, start, stop, polarity_free=False):
    """Best position of `segment` inside reference[start:stop]; returns (position, ncc, floor).
    A microphone may invert polarity, which changes nothing about time: then |ncc| is used.
    `floor` is the median |ncc| over the search range (the correlation noise floor)."""
    start, stop = max(0, start), min(len(reference), stop + len(segment))
    search = reference[start:stop]
    if len(search) < len(segment):
        return None, 0.0, 0.0
    scores = correlate(search, segment, mode="valid", method="fft")
    squares = np.concatenate(([0.0], np.cumsum(search * search)))
    energy = np.maximum(squares[len(segment):] - squares[:-len(segment)], 1e-18)
    ncc = scores / np.sqrt(energy * np.sum(segment * segment) + 1e-18)
    score = np.abs(ncc) if polarity_free else ncc
    best = int(np.argmax(score))
    return start + peak(score, best), float(score[best]), float(np.median(np.abs(ncc)))


def main():
    master_path, backing_path, vocal_path, out_path = sys.argv[1:5]
    master, backing, vocal = mono(master_path), mono(backing_path), mono(vocal_path)
    band = butter(4, [300, 3400], btype="bandpass", fs=ANALYSIS_RATE, output="sos")
    vocal_band = sosfiltfilt(band, vocal)
    # Global map file -> song position from the loudest 10 s of backing in the file.
    second = ANALYSIS_RATE
    probe_at = max(range(0, max(1, len(master) - 10 * second), second),
                   key=lambda i: np.sum(master[i:i + 10 * second] ** 2))
    song_at, confidence, _ = locate(master[probe_at:probe_at + 10 * second], backing, 0, len(backing))
    offset = song_at - probe_at  # song sample = file sample + offset
    song_seconds = len(backing) / second
    windows = {
        "start": (20.0, 40.0),
        "middle": (song_seconds / 2 - 10, song_seconds / 2 + 10),
        "end": (song_seconds - 40, song_seconds - 20),
    }
    result = {"globalBackingConfidence": confidence, "fileStartsAtSongSeconds": offset / second,
              "fileSeconds": len(master) / second, "songSeconds": song_seconds, "windows": {}}
    lags = {}
    for name, (begin, end) in windows.items():
        file_begin = int(begin * second - offset)
        file_end = int(end * second - offset)
        if file_begin < 0 or file_end > len(master):
            result["windows"][name] = {"status": "outside recording"}
            continue
        segment = master[file_begin:file_end]
        b_pos, b_ncc, _ = locate(segment, backing, int(begin * second) - second, int(begin * second) + second)
        b_index = int(round(b_pos))
        aligned = backing[b_index:b_index + len(segment)]
        gain = float(np.dot(segment, aligned) / max(np.dot(aligned, aligned), 1e-18))
        residual = sosfiltfilt(band, segment - gain * aligned)
        # The remote voice was sung to an earlier song position: search up to 1 s back.
        v_pos, v_ncc, floor = locate(residual, vocal_band, b_index - second, b_index + second // 10,
                                     polarity_free=True)
        entry = {"backingNcc": b_ncc, "vocalAbsNcc": v_ncc, "vocalNccFloor": floor,
                 "peakToFloor": round(v_ncc / max(floor, 1e-9), 1), "backingGain": gain}
        lag_ms = None if v_pos is None else (b_pos - v_pos) / second * 1000
        # TEST_PLAN.md criterion, unchanged: a normalised maximum below 0.2 is "not found".
        entry["planStatus"] = "ok" if v_pos is not None and v_ncc >= 0.2 else "voice not found"
        # Secondary criterion (reported separately): a peak far above the correlation floor.
        if lag_ms is not None and v_ncc >= 10 * floor:
            entry["remoteVocalLateMs"] = round(lag_ms, 2)
            lags[name] = (lag_ms, file_begin, file_end, b_index)
        result["windows"][name] = entry
        continue
        result["windows"][name] = entry
    # Lag every 10 s through the whole file (secondary criterion), for drift.
    track = []
    for file_begin in range(0, len(master) - 10 * second, 10 * second):
        segment = master[file_begin:file_begin + 10 * second]
        song_begin = int(file_begin + offset)
        b_pos, b_ncc, _ = locate(segment, backing, song_begin - second // 2, song_begin + second // 2)
        if b_pos is None or b_ncc < 0.3:
            continue
        b_index = int(round(b_pos))
        aligned = backing[b_index:b_index + len(segment)]
        if len(aligned) < len(segment):
            continue
        gain = float(np.dot(segment, aligned) / max(np.dot(aligned, aligned), 1e-18))
        residual = sosfiltfilt(band, segment - gain * aligned)
        v_pos, v_ncc, floor = locate(residual, vocal_band, b_index - second, b_index + second // 10,
                                     polarity_free=True)
        if v_pos is not None and v_ncc >= 10 * floor:
            track.append({"songSeconds": round(b_index / second, 1),
                          "lateMs": round((b_pos - v_pos) / second * 1000, 2),
                          "absNcc": round(v_ncc, 3), "peakToFloor": round(v_ncc / max(floor, 1e-9), 1)})
    # A match at ~0 ms lines up with the LOCAL backing: vocal residue inside the instrumental stem
    # (stem separation), not the remote voice, which cannot arrive before its own deadline.
    for entry in track:
        entry["localBleed"] = bool(abs(entry["lateMs"]) < 5)
    result["track"] = track
    remote = [t for t in track if not t["localBleed"]]
    if len(remote) >= 3:
        x = np.array([t["songSeconds"] for t in remote])
        y = np.array([t["lateMs"] for t in remote])
        slope = float(np.polyfit(x, y, 1)[0])
        result["trackSummary"] = {"windows": len(remote), "localBleedWindows": len(track) - len(remote), "medianMs": round(float(np.median(y)), 2),
                                  "minMs": round(float(y.min()), 2), "maxMs": round(float(y.max()), 2),
                                  "slopeMsPerMinute": round(slope * 60, 2)}
    found = [value[0] for value in lags.values()]
    if len(found) >= 2:
        ordered = [lags[n][0] for n in ("start", "middle", "end") if n in lags]
        change = ordered[-1] - ordered[0]
        result["drift"] = {"endMinusStartMs": round(change, 2), "drift": bool(abs(change) > 5)}
    # Dropouts over the whole file, at the lag of the nearest window.
    if lags:
        lag_samples = int(round(np.median(found) / 1000 * second))
        file_song = np.arange(len(master)) + offset
        idx = np.clip(file_song.astype(int), 0, len(backing) - 1)
        aligned_backing = backing[idx]
        gain = float(np.dot(master, aligned_backing) / max(np.dot(aligned_backing, aligned_backing), 1e-18))
        received = sosfiltfilt(band, master - gain * aligned_backing)
        expected = vocal_band[np.clip(idx - lag_samples, 0, len(vocal_band) - 1)]
        frame = int(0.02 * second)
        count = len(received) // frame
        env = lambda x: 10 * np.log10(np.mean(x[:count * frame].reshape(count, frame) ** 2, axis=1) + 1e-18)
        got, want = env(received), env(expected)
        singing = want > np.median(want[want > np.percentile(want, 30)]) - 35
        level = np.median(got[singing]) if singing.any() else -120
        missing = singing & (got < level - 30)
        dropouts, run = [], 0
        for i, flag in enumerate(np.append(missing, False)):
            if flag:
                run += 1
            elif run:
                if run * 20 >= 60:
                    start = (i - run) * frame
                    dropouts.append({"songSeconds": round((start + offset) / second, 2), "ms": run * 20})
                run = 0
        result["dropouts"] = dropouts
        result["singingFramesAnalysed"] = int(singing.sum())
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print(json.dumps(result, indent=2))


main()
