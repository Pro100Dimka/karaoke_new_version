"""Offline copies only: verify known loss durations against an actual paired run.

No sound is played, no application API is called and no source WAV is changed.
Usage: python validate_actual_detector.py <run-config.json> <run-result.json> <out.json>
"""
import json
from pathlib import Path
import sys

import numpy as np
from scipy.signal import butter, resample_poly, sosfiltfilt
import analyze_real_mic as a


def main():
    config_path, result_path, output_path = map(Path, sys.argv[1:4])
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    measured = json.loads(result_path.read_text(encoding="utf-8-sig"))
    if measured["status"] != "PASS":
        raise ValueError("actual unmodified run must pass the confidence gate before calibration")
    directory = config_path.parent
    paths = {key: Path(value) if Path(value).is_absolute() else directory / value
             for key, value in config.items() if key in ("receiverMaster", "renderedBacking", "senderMic", "backing")}
    pcm = {key: a.read_channel(path, config.get(key + "Channel", 0)) for key, path in paths.items()}
    master_native, header = a.read_channel(paths["receiverMaster"], config.get("receiverMasterChannel", 0), resample=False)
    backing_native, _ = a.read_channel(paths["renderedBacking"], config.get("renderedBackingChannel", 0), resample=False)
    native_rate = header["sampleRate"]
    sender = pcm["senderMic"][0]
    band = butter(4, [300, 3400], fs=a.RATE, btype="bandpass", output="sos")
    filtered = sosfiltfilt(band, sender - np.mean(sender))
    frame = int(.02 * a.RATE)
    count = len(filtered) // frame
    energy_db = 10 * np.log10(np.mean(filtered[:count * frame].reshape(count, frame) ** 2, axis=1) + 1e-18)
    window = next(iter(measured["windows"].values()))
    offset = window["micFileSeconds"] - window["receiverFileSeconds"]
    positions = np.arange(len(master_native)) / native_rate + offset
    index = np.clip((positions / .02).astype(int), 0, count - 1)
    active = ((energy_db[index] > measured["dropouts"]["senderActiveThresholdDb"]) &
              (positions > config.get("senderActiveFromSeconds", 0)))
    edges = np.flatnonzero(np.diff(np.r_[False, active, False].astype(np.int8)))
    candidates = [(begin, end) for begin, end in zip(edges[::2], edges[1::2])
                  if (end - begin) / native_rate > .3]
    if not candidates:
        raise ValueError("no sufficiently long sender-active interval for known-mute validation")
    begin, end = max(candidates, key=lambda pair: pair[1] - pair[0])
    # Deliberately choose a non-20ms-grid start, away from vocal onset and pause.
    begin += round(.027 * native_rate)
    sender_timeline, _ = a.read_timeline(str(paths["senderMic"]) + ".timeline.csv", "sender",
                                         pcm["senderMic"][1]["frames"], pcm["senderMic"][1]["sampleRate"])
    receiver_timeline, _ = a.read_timeline(str(paths["receiverMaster"]) + ".timeline.csv", "receiver",
                                           header["frames"], native_rate)
    origin = a.sender_song_origin(sender_timeline, config["songStartRoomFrame"], 48000)
    original_residual = master_native - backing_native
    trials = []
    for milliseconds in (60, 100, 220):
        stop = begin + round(milliseconds * native_rate / 1000)
        modified = original_residual.copy()
        modified[begin:stop] = 0  # Offline loss in a copy of an actual captured voice.
        modified_master = backing_native + modified
        master_8k = resample_poly(modified_master, a.RATE, native_rate)
        result = a.analyze_arrays(master_8k, pcm["backing"][0], sender,
                                  sender_song_seconds=origin,
                                  sender_timeline=sender_timeline, receiver_timeline=receiver_timeline,
                                  sender_native_rate=pcm["senderMic"][1]["sampleRate"],
                                  receiver_native_rate=native_rate,
                                  song_start_room_frame=config["songStartRoomFrame"],
                                  short=config.get("shortComparison", False),
                                  rendered_backing=pcm["renderedBacking"][0],
                                  native_residual=modified, native_rate=native_rate,
                                  sender_noise_seconds=config["senderNoiseSeconds"],
                                  sender_active_from_seconds=config.get("senderActiveFromSeconds", 0))
        gaps = result["dropouts"]
        matched = [event for event in gaps["intervals"]
                   if abs(event["durationMs"] - milliseconds) < 1]
        passed = result["status"] == "PASS" and len(matched) == 1
        trials.append({"knownLossMs": milliseconds, "receiverWavStartSeconds": begin / native_rate,
                       "notAlignedTo20msGrid": bool(begin % round(.02 * native_rate)),
                       "validation": "PASS" if passed else "FAIL", "analysisStatus": result["status"],
                       "micNcc": {name: entry["micAbsNcc"] for name, entry in result["windows"].items()},
                       "dropouts": gaps})
    output = {"scope": "Offline mutated copies of actual residual; no application injection; originals unchanged",
              "config": str(config_path), "unmodifiedResult": str(result_path), "trials": trials,
              "status": "PASS" if all(row["validation"] == "PASS" for row in trials) else "FAIL"}
    output_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps(output, indent=2))
    return 0 if output["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
