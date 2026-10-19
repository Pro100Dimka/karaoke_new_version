"""Read-only diagnostics for frozen 2026-10-15 A evidence; never changes its gate.

Run with the repository Python venv. Independent short-window lag searches are
reported as waveform candidates, never stitched or used to pass a failed cell.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import types

import numpy as np
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfiltfilt

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / "2026-10-15-direct-late-recovery"
BASELINE_COMMIT = "da3b7176"
SOURCE_PATH = "artifacts/room-e2e/2026-10-15-real-mic-v2/analyze_real_mic.py"
# Freeze the historical analyzer even when today's working-copy analyzer is
# corrected. This trusted repository source is read into memory, never edited.
baseline_source = subprocess.check_output(["git", "show", f"{BASELINE_COMMIT}:{SOURCE_PATH}"],
                                          cwd=HERE.parents[2], text=True)
a = types.ModuleType("historical_real_mic_analysis")
exec(compile(baseline_source, f"{BASELINE_COMMIT}:{SOURCE_PATH}", "exec"), a.__dict__)


def diagnostic_match(chunk, reference, expected, radius, rate=8000, polarity_free=True):
    match = a.locate(chunk, reference, expected - radius * rate,
                     expected + radius * rate + 1, rate,
                     polarity_free=polarity_free)
    match["candidateMinusClockMs"] = (match["position"] - expected) / rate * 1000
    return match


def summary(rows):
    active = [row for row in rows if row["sourceActive"]]
    result = {"allSegments": len(rows), "activeSegments": len(active)}
    for radius in (5, 25, 100):
        key = f"positive{radius}ms"
        found = [row[key] for row in active]
        result[key] = {
            "atOrAbovePoint2": sum(row["ncc"] >= .2 for row in found),
            "nccMinMedianMax": [float(x) for x in np.percentile(
                [row["ncc"] for row in found], [0, 50, 100])] if found else None,
            "candidateShiftMinMedianMaxMs": [float(x) for x in np.percentile(
                [row["candidateMinusClockMs"] for row in found], [0, 50, 100])] if found else None,
        }
    return result


def main():
    config = json.loads((OLD / "final-host-to-laptop-config.json").read_text(encoding="utf-8-sig"))
    strict = json.loads((OLD / "final-host-to-laptop-strict-result.json").read_text())
    previous = json.loads((OLD / "final-host-to-laptop-segmented-result.json").read_text())
    paths = {key: OLD / config[key] for key in ("senderMic", "receiverMaster", "renderedBacking")}
    native, info = {}, {}
    for key, path in paths.items():
        native[key], rate = sf.read(path, always_2d=True, dtype="float64")
        info[key] = {"sampleRate": rate, "channels": native[key].shape[1],
                     "frames": len(native[key]),
                     "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        assert rate == 48000
    assert native["receiverMaster"].shape == native["renderedBacking"].shape
    src = resample_poly(native["senderMic"][:, 0], 1, 6)
    residue = native["receiverMaster"] - native["renderedBacking"]
    raw = [resample_poly(residue[:, channel], 1, 6) for channel in range(2)]
    band = butter(4, [300, 3400], fs=8000, btype="bandpass", output="sos")
    filtered = [sosfiltfilt(band, wave) for wave in raw]
    sender = sosfiltfilt(band, src)
    native_band = butter(4, [300, 3400], fs=48000, btype="bandpass", output="sos")
    native_sender = sosfiltfilt(native_band, native["senderMic"][:, 0])
    native_filtered = sosfiltfilt(native_band, residue[:, 0])
    sender_timeline, sender_info = a.read_timeline(str(paths["senderMic"]) + ".timeline.csv", "sender",
                                                 len(native["senderMic"]), 48000)
    receiver_timeline, receiver_info = a.read_timeline(str(paths["receiverMaster"]) + ".timeline.csv", "receiver",
                                                     len(native["receiverMaster"]), 48000)
    room = np.array([row["effectiveRoomFrame"] for row in sender_timeline] + [sender_timeline[-1]["endEffectiveRoomFrame"]])
    wav = np.array([row["wavFrame"] for row in sender_timeline] + [len(native["senderMic"])])
    recv_wav = np.array([row["wavFrame"] for row in receiver_timeline] + [len(residue)])
    recv_room = np.array([row["presentationRoomFrame"] for row in receiver_timeline] + [receiver_timeline[-1]["endPresentationRoomFrame"]])

    def clock_source(file_sample):
        stamp = np.interp(file_sample * 6, recv_wav, recv_room) - config["selectedDeadlineMs"] * 48
        return float(np.interp(stamp, room, wav)) / 6

    old_presence = {int(row["receiverFileSeconds"]): row for row in previous["matchedVoicePresence"]["wholeSongIdentity"]["subwindows"]}
    events = []
    for name, window in previous["windows"].items():
        for row in window["subwindows"]:
            if row["voiceActiveMs"] and not row["accepted"]:
                events.append({"kind": "FAILED_MANDATORY_CELL", "songSeconds": row["songSeconds"],
                               "durationMs": 1000, "receiverSample": round(row["receiverFileSeconds"] * 8000),
                               "originalNcc": row["micNcc"], "originalRow": row})
    for row in previous["matchedVoicePresence"]["unidentifiedIntervals"]:
        events.append({"kind": "UNKNOWN_ACTIVE", **row,
                       "receiverSample": round((row["songSeconds"] - strict["fileStartsAtSongSeconds"]) * 8000)})
    for event in events:
        at, count = event["receiverSample"], round(event["durationMs"] * 8)
        expected = clock_source(at)
        event["clockExpectedSourceFileSeconds"] = expected / 8000
        event["constantShiftWholeEvent"] = {
            "filteredChannel0": diagnostic_match(filtered[0][at:at + count], sender, expected, .25),
            "filteredChannel1": diagnostic_match(filtered[1][at:at + count], sender, expected, .25),
            "rawChannel0": diagnostic_match(raw[0][at:at + count], src, expected, .25),
            "native48kFilteredChannel0": diagnostic_match(native_filtered[at * 6:(at + count) * 6],
                                                            native_sender, expected * 6, .25, rate=48000),
        }
        if event["kind"] == "FAILED_MANDATORY_CELL":
            event["same8kSignalsInterpolatedLagSearch"] = {}
            reference_start = int(expected - 2000) - 128
            reference_end = int(expected + 2000) + count + 128
            for factor in (2, 3, 6, 12):
                chunk = resample_poly(filtered[0][at - 128:at + count + 128], factor, 1)[128 * factor:(128 + count) * factor]
                reference = resample_poly(sender[reference_start:reference_end], factor, 1)
                match = diagnostic_match(chunk, reference, (expected - reference_start) * factor,
                                         .25, rate=8000 * factor)
                match["sourceFileSeconds"] = (match["position"] / factor + reference_start) / 8000
                event["same8kSignalsInterpolatedLagSearch"][str(factor)] = match
        native_at = at * 6
        native_count = count * 6
        block = residue[native_at:native_at + native_count]
        event["residualNative"] = {"rmsChannel0": float(np.sqrt(np.mean(block[:, 0] ** 2))),
                                    "channelDifferenceRms": float(np.sqrt(np.mean((block[:, 0] - block[:, 1]) ** 2))),
                                    "peakChannel0": float(np.max(np.abs(block[:, 0]))),
                                    "atMost2LsbFraction": float(np.mean(np.abs(block[:, 0]) <= 2 / 32768)),
                                    "masterClipFraction": float(np.mean(np.abs(native["receiverMaster"][native_at:native_at + native_count, 0]) >= 32767 / 32768))}
        for piece_ms in (20, 50, 100):
            if piece_ms > event["durationMs"]:
                continue
            width = piece_ms * 8
            rows = []
            for offset in range(0, count - width + 1, width):
                pos = clock_source(at + offset)
                want = a.fractional_slice(sender, pos, width)
                db = float(10 * np.log10(np.mean(want * want) + 1e-18))
                row = {"offsetMs": offset / 8, "sourceDb": db,
                       "sourceActive": db > previous["senderActivityThresholdDb"]}
                for radius in (5, 25, 100):
                    row[f"positive{radius}ms"] = diagnostic_match(filtered[0][at + offset:at + offset + width], sender,
                                                                  pos, radius / 1000, polarity_free=False)
                rows.append(row)
            event[f"independent{piece_ms}ms"] = {"summary": summary(rows), "segments": rows}
        # Reproduce the *original* positive-only +/-5 ms local classifier at
        # its one-second expected-waveform origin, without applying a new warp.
        original = []
        if event["kind"] == "UNKNOWN_ACTIVE":
            for offset in range(0, count, 160):
                absolute = at + offset
                one = absolute // 8000
                one_row = old_presence[one]
                pos = one_row["sourceFileSeconds"] * 8000 + absolute - one * 8000
                expected_one = a.fractional_slice(sender, one_row["sourceFileSeconds"] * 8000, 8000)
                start = absolute - one * 8000
                context = expected_one[start - 40:start + 200]
                assert len(context) == 240
                segment = filtered[0][absolute:absolute + 160]
                segment = segment - segment.mean()
                sums = np.r_[0.0, np.cumsum(context)]
                squares = np.r_[0.0, np.cumsum(context * context)]
                energy = np.maximum(squares[160:] - squares[:-160] -
                                    (sums[160:] - sums[:-160]) ** 2 / 160, 1e-18)
                dots = np.correlate(context, segment, mode="valid")
                ncc = dots / np.sqrt(np.maximum(energy * np.dot(segment, segment), 1e-18))
                best = int(np.argmax(ncc))
                original.append({"offsetMs": offset / 8, "originalOneSecondOrigin": one_row["sourceFileSeconds"],
                                 "ncc": float(ncc[best]),
                                 "candidateMinusOriginalExpectedMs": (best - 40) / 8})
        event["original20msClassifierReproduction"] = original
    output = {"scope": "READ_ONLY_DIAGNOSTIC; no acceptance, no replacement of failed cells, no stitched/warped waveform",
              "historicalAnalyzerCommit": BASELINE_COMMIT,
              "historicalAnalyzerSha256": hashlib.sha256(baseline_source.encode()).hexdigest(),
              "unchangedGate": .2, "files": info, "senderTimeline": sender_info,
              "receiverTimeline": receiver_info, "events": events,
              "limitations": ["No continuous historical packet/render trace: no network/PLC cause classification is inferred.",
                              "20/50/100ms peaks can be periodic voice matches, PLC, or stale/retimed source; they do not independently prove REAL identity.",
                              "Expanded search is diagnostic only and does not modify the existing +/-5ms missing classifier or mandatory 1s gate."]}
    (HERE / "old-host-to-laptop-signal-diagnostics.json").write_text(json.dumps(output, indent=2) + "\n")
    for row in events:
        fixed = row["constantShiftWholeEvent"]["filteredChannel0"]
        local = row["independent20ms"]["summary"]
        print(row["kind"], row["songSeconds"], "fixed", round(fixed["ncc"], 4), "signed", round(fixed["signedNcc"], 4),
              "20ms", [(x, local[f"positive{x}ms"]["atOrAbovePoint2"], local["activeSegments"]) for x in (5, 25, 100)])


if __name__ == "__main__":
    main()
