"""User-approved 1s gate, retaining strict 20s evidence separately.

python diagnose_real_mic_windows.py config.json primary-result.json out.json [0.25|1]
No waveform stretching, no application calls, NCC threshold remains 0.2.
"""
import json
from pathlib import Path
import sys

import numpy as np
from scipy.signal import butter, sosfiltfilt
import analyze_real_mic as a


def match_with_context(residual, sender, file_start, count, approximate, allowed_begin, allowed_end, rate):
    chunk = residual[file_start:file_start + count]
    first = a.locate(chunk, sender, approximate - rate, approximate + rate // 4, rate)
    first.update(contextSeconds=count / rate,
                 accepted=bool(first["ncc"] >= a.NCC_GATE and first["uniquePeak"]))
    if first["accepted"] or first["ncc"] < a.NCC_GATE:
        return first
    for context_seconds in (2, 3):
        context_count = context_seconds * rate
        if allowed_end - allowed_begin < context_count:
            continue
        context_begin = max(allowed_begin, min(file_start - (context_count - count) // 2,
                                               allowed_end - context_count))
        context_approximate = approximate + context_begin - file_start
        context = a.locate(residual[context_begin:context_begin + context_count], sender,
                           context_approximate - rate, context_approximate + rate // 4, rate)
        if context["ncc"] < a.NCC_GATE or not context["uniquePeak"]:
            continue
        anchored = context["position"] + file_start - context_begin
        # The unique wider waveform selects the correct occurrence. The 1s
        # target must still independently reach NCC .2 around that occurrence.
        refined = a.locate(chunk, sender, anchored - .005 * rate, anchored + .005 * rate, rate)
        if refined["ncc"] >= a.NCC_GATE:
            refined.update(accepted=True, contextSeconds=context_seconds,
                           contextNcc=context["ncc"], contextSecondPeakNcc=context["secondPeakNcc"],
                           contextUniquePeak=context["uniquePeak"],
                           originalNcc=first["ncc"], originalSecondPeakNcc=first["secondPeakNcc"])
            return refined
    return first


def summarize(rows):
    voiced = [row for row in rows if row["voiceActiveMs"] > 0]
    accepted = [row for row in voiced if row["accepted"]]
    total = sum(row["voiceActiveMs"] for row in voiced)
    matched = sum(row["voiceActiveMs"] for row in accepted)
    lags = [row["micToRemoteMs"] for row in accepted]
    relative = [row["effectiveVoiceToBackingMs"] for row in accepted if "effectiveVoiceToBackingMs" in row]
    relative_voiced = sum(row["voiceActiveMs"] for row in accepted if "effectiveVoiceToBackingMs" in row)
    nccs = [row["micNcc"] for row in accepted]
    return {"scope": "DIAGNOSTIC_ONLY", "voicedSubwindows": len(voiced),
            "requiredWindowComplete": not any(row.get("status", "").startswith(("outside", "clock-invalid", "matched WAV")) for row in rows),
            "acceptedSubwindows": len(accepted), "voicedMs": total,
            "acceptedVoicedMs": matched, "unidentifiedVoicedMs": total - matched,
            "acceptedVoicedFraction": matched / total if total else None,
            "backingAcceptedVoicedFraction": relative_voiced / total if total else None,
            "physicalLagMs": None if not lags else {
                "median": float(np.median(lags)), "min": min(lags), "max": max(lags),
                "p10": float(np.percentile(lags, 10)), "p90": float(np.percentile(lags, 90))},
            "effectiveVoiceToBackingMs": None if not relative else {
                "median": float(np.median(relative)), "min": min(relative), "max": max(relative),
                "p10": float(np.percentile(relative, 10)), "p90": float(np.percentile(relative, 90))},
            "micNcc": None if not nccs else {"min": min(nccs), "median": float(np.median(nccs))}}


def primary_report(windows):
    passed = all(windows[name]["acceptedVoicedFraction"] == 1 and windows[name]["physicalLagMs"] is not None
                 and windows[name].get("requiredWindowComplete", True)
                 for name in ("start", "middle", "end"))
    result = {"confidenceStatus": "PASS" if passed else "FAIL", "medianLagMs": None, "drift": None}
    if passed:
        values = [windows[name]["physicalLagMs"]["median"] for name in ("start", "middle", "end")]
        change = values[-1] - values[0]
        result.update(medianLagMs=float(np.median(values)),
                      drift={"endMinusStartMs": change, "detected": bool(abs(change) > 5)})
    return result


def source_frames_from_clock(room_frames, source_stamps, source_wav):
    positions = np.interp(room_frames, source_stamps, source_wav, left=np.nan, right=np.nan)
    available = (room_frames >= source_stamps[0]) & (room_frames < source_stamps[-1])
    return positions, available


def match_song_presence(received, sender, clock_starts, source_active_frames, rate,
                         noise_floor_db, native_received, native_rate, song_origin,
                         native_source_active=None):
    expected = np.zeros_like(received)
    rows, gains = [], []
    frames_per_second = round(1 / .02)
    for block, file_start in enumerate(range(0, len(received), rate)):
        count = min(rate, len(received) - file_start)
        active_ms = int(np.sum(source_active_frames[block * frames_per_second:(block + 1) * frames_per_second])) * 20
        approximate = clock_starts[block]
        if not active_ms or not np.isfinite(approximate):
            continue
        match = match_with_context(received, sender, file_start, count, approximate, 0, len(received), rate)
        # Presence always checks the independently intended current packet;
        # even a unique old/replayed waveform cannot substitute for it.
        # This does not establish a unique timing measurement. Half the
        # existing 50ms separated-peak exclusion bounds the local occurrence.
        presence = a.locate(received[file_start:file_start + count], sender,
                            approximate - .025 * rate, approximate + .025 * rate, rate)
        presence_accepted = presence["ncc"] >= a.NCC_GATE
        position = presence["position"] if presence_accepted else approximate
        aligned = a.fractional_slice(sender, position, count)
        expected[file_start:file_start + count] = aligned
        if presence_accepted:
            gains.append(float(np.dot(received[file_start:file_start + count], aligned) /
                               max(np.dot(aligned, aligned), 1e-18)))
        rows.append({"receiverFileSeconds": file_start / rate, "voiceActiveMs": active_ms,
                     "accepted": match["accepted"], "micNcc": match["ncc"],
                     "secondPeakNcc": match["secondPeakNcc"],
                     "clockAnchoredPresence": bool(presence_accepted and not match["accepted"]),
                     "presenceNcc": presence["ncc"], "presenceAccepted": bool(presence_accepted),
                     "globalMatchMinusClockMs": (match["position"] - approximate) / rate * 1000 if match["position"] is not None else None,
                     "clockExpectedSourceFileSeconds": approximate / rate,
                     "sourceFileSeconds": position / rate,
                     "contextSeconds": match["contextSeconds"]})
    normal_gain = float(np.median(gains)) if gains else 1.0
    result = a.missing_intervals(received, expected, rate, song_origin, normal_gain, noise_floor_db,
                                 native_received=native_received, native_rate=native_rate,
                                 source_active_frames=source_active_frames,
                                 native_source_active=native_source_active)
    unknown = [row for row in rows if not row["presenceAccepted"] and row["voiceActiveMs"] >= 60]
    result["wholeSongIdentity"] = {"voicedMs": sum(row["voiceActiveMs"] for row in rows),
                                   "acceptedVoicedMs": sum(row["voiceActiveMs"] for row in rows if row["accepted"]),
                                   "clockAnchoredPresenceVoicedMs": sum(row["voiceActiveMs"] for row in rows if row["clockAnchoredPresence"]),
                                   "unidentifiedOneSecondCells": unknown, "subwindows": rows,
                                   "method": "Independent packet-clock activity; unique 1s/2s/3s timing matches, ambiguous repeats use the clock-local +/-25ms candidate for presence only; unchanged 20ms component/gain gate rejects unknown/attenuated voice; no waveform stretching"}
    if unknown:
        result["status"] = "INDETERMINATE"
    return result


def main():
    config_path, primary_path, output_path = map(Path, sys.argv[1:4])
    seconds = float(sys.argv[4]) if len(sys.argv) > 4 else .25
    if seconds not in (.25, 1):
        raise ValueError("diagnostic subwindow must be 0.25 or 1 seconds")
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    primary = json.loads(primary_path.read_text(encoding="utf-8-sig"))
    approved = config.get("approvedOneSecondGate", False)
    if approved and seconds != 1:
        raise ValueError("the user approved one-second segments")
    paths = {key: Path(value) if Path(value).is_absolute() else config_path.parent / value
             for key, value in config.items() if key in ("receiverMaster", "renderedBacking", "senderMic", "backing")}
    pcm = {key: a.read_channel(path, config.get(key + "Channel", 0)) for key, path in paths.items()}
    sender_timeline, _ = a.read_timeline(str(paths["senderMic"]) + ".timeline.csv", "sender",
                                         pcm["senderMic"][1]["frames"], pcm["senderMic"][1]["sampleRate"])
    receiver_timeline, _ = a.read_timeline(str(paths["receiverMaster"]) + ".timeline.csv", "receiver",
                                           pcm["receiverMaster"][1]["frames"], pcm["receiverMaster"][1]["sampleRate"])
    sender_origin = a.sender_song_origin(sender_timeline, config["songStartRoomFrame"], 48000)
    band = butter(4, [300, 3400], fs=a.RATE, btype="bandpass", output="sos")
    sender = sosfiltfilt(band, pcm["senderMic"][0])
    residual = sosfiltfilt(band, pcm["receiverMaster"][0] - pcm["renderedBacking"][0])
    noise_begin, noise_end = [round(value * a.RATE) for value in config["senderNoiseSeconds"]]
    frame = int(.02 * a.RATE)
    frame_energy = lambda x: np.mean(x[:len(x) // frame * frame].reshape(-1, frame) ** 2, axis=1)
    noise_db = float(10 * np.log10(np.percentile(frame_energy(sender[noise_begin:noise_end]), 95) + 1e-18))
    db = 10 * np.log10(frame_energy(sender) + 1e-18)
    higher = db > np.percentile(db, 30)
    threshold = max(float(np.median(db[higher])) - 35, noise_db + 10)
    offset = primary["fileStartsAtSongSeconds"]
    duration = len(pcm["backing"][0]) / a.RATE
    windows = {"start": (20, 40), "middle": (duration / 2 - 10, duration / 2 + 10),
               "end": (duration - 40, duration - 20)}
    output = {"scope": "DIAGNOSTIC_ONLY: user has not approved replacing the strict 20s gate",
              "strictPrimaryStatus": primary["status"], "strictPrimaryResult": str(primary_path),
              "subwindowSeconds": seconds, "nccGate": a.NCC_GATE,
              "senderNoiseFloorDb": noise_db, "senderActivityThresholdDb": threshold, "windows": {}}
    if approved:
        output["scope"] = "USER_APPROVED_1S: explicit instruction 'Да, использовать секундные участки'; strict 20s result retained separately"
        output["selectedDeadlineMs"] = config["selectedDeadlineMs"]
    effective_stamps = np.array([row["effectiveRoomFrame"] for row in sender_timeline] + [sender_timeline[-1]["endEffectiveRoomFrame"]])
    source_wav = np.array([row["wavFrame"] for row in sender_timeline] + [sender_timeline[-1]["wavFrame"] + sender_timeline[-1]["wavFrames"]])
    all_accepted = []
    for name, (begin, end) in windows.items():
        rows = []
        for song_at in np.arange(begin, end - seconds / 2, seconds):
            file_start = round((song_at - offset) * a.RATE)
            count = round(seconds * a.RATE)
            chunk = residual[file_start:file_start + count]
            if file_start < 0 or len(chunk) != count:
                rows.append({"voiceActiveMs": 0, "accepted": False, "status": "outside recording"})
                continue
            approximate = (song_at - sender_origin) * a.RATE
            match = (match_with_context(residual, sender, file_start, count, approximate,
                                        max(0, round((begin - offset) * a.RATE)),
                                        min(len(residual), round((end - offset) * a.RATE)), a.RATE)
                     if approved else a.locate(chunk, sender, approximate - a.RATE, approximate + a.RATE // 4, a.RATE))
            source_start = match["position"] if match["position"] is not None else approximate
            activity_start = source_start
            if approved:
                # Activity is determined from the authoritative packet clock and
                # selected deadline, never from a failed peak landing in silence.
                presented_activity = a.timeline_position(receiver_timeline,
                    file_start / a.RATE * pcm["receiverMaster"][1]["sampleRate"], "presentationRoomFrame")
                expected_stamp = presented_activity - config["selectedDeadlineMs"] * 48
                expected_native, source_available = source_frames_from_clock(expected_stamp, effective_stamps, source_wav)
                source_available = bool(source_available and expected_stamp + seconds * 48000 <= effective_stamps[-1])
                activity_start = expected_native / pcm["senderMic"][1]["sampleRate"] * a.RATE if source_available else 0
            begin_frame = max(0, int(activity_start // frame))
            end_frame = min(len(db), int((activity_start + count) // frame))
            active = db[begin_frame:end_frame] > threshold
            row = {"songSeconds": float(song_at), "receiverFileSeconds": file_start / a.RATE,
                   "sourceFileSeconds": source_start / a.RATE, "voiceActiveMs": int(active.sum()) * 20,
                   "activitySourceFileSeconds": activity_start / a.RATE,
                   "micNcc": match["ncc"], "secondPeakNcc": match["secondPeakNcc"],
                   "peakRatio": match["peakRatio"], "uniquePeak": match["uniquePeak"],
                   "accepted": bool(match.get("accepted", match["ncc"] >= a.NCC_GATE and match["uniquePeak"]))}
            row.update({key: value for key, value in match.items() if key.startswith("context") or key.startswith("original")})
            if approved and not source_available:
                row.update(accepted=False, status="outside source reference")
            if row["accepted"]:
                try:
                    source_frame = source_start / a.RATE * pcm["senderMic"][1]["sampleRate"]
                    target_frame = file_start / a.RATE * pcm["receiverMaster"][1]["sampleRate"]
                    a.validate_timeline_span(sender_timeline, source_frame, source_frame + seconds * pcm["senderMic"][1]["sampleRate"])
                    a.validate_timeline_span(receiver_timeline, target_frame, target_frame + seconds * pcm["receiverMaster"][1]["sampleRate"])
                    captured = a.timeline_position(sender_timeline, source_frame, "physicalRoomFrame")
                    effective = a.timeline_position(sender_timeline, source_frame, "effectiveRoomFrame")
                    presented = a.timeline_position(receiver_timeline, target_frame, "presentationRoomFrame")
                    row["micToRemoteMs"] = (presented - captured) / 48
                    row["effectiveMusicalLagMs"] = (presented - effective) / 48
                    backing_match = a.locate(pcm["renderedBacking"][0][file_start:file_start + count],
                                             pcm["backing"][0], (song_at - .1) * a.RATE,
                                             (song_at + .1) * a.RATE, a.RATE, backing=True, polarity_free=False)
                    row["backingNcc"] = backing_match["ncc"]
                    if backing_match["position"] is not None and backing_match["ncc"] >= a.NCC_GATE:
                        row["backingSongSeconds"] = backing_match["position"] / a.RATE
                        row["effectiveVoiceToBackingMs"] = row["backingSongSeconds"] * 1000 - (effective - config["songStartRoomFrame"]) / 48
                    all_accepted.append(row)
                except ValueError as error:
                    row.update(accepted=False, status=str(error))
            rows.append(row)
        summary = summarize(rows)
        if approved:
            summary["scope"] = "USER_APPROVED_1S"
        output["windows"][name] = {"summary": summary, "subwindows": rows}
    if all_accepted:
        # Activity correspondence is diagnostic only when the strict primary
        # fails. Waveforms and clock rates remain untouched.
        raw_master, header = a.read_channel(paths["receiverMaster"], config.get("receiverMasterChannel", 0), resample=False)
        raw_backing, _ = a.read_channel(paths["renderedBacking"], config.get("renderedBackingChannel", 0), resample=False)
        if approved:
            render_wav = np.array([row["wavFrame"] for row in receiver_timeline] + [receiver_timeline[-1]["wavFrame"] + receiver_timeline[-1]["wavFrames"]])
            render_stamps = np.array([row["presentationRoomFrame"] for row in receiver_timeline] + [receiver_timeline[-1]["endPresentationRoomFrame"]])
            expected_stamps = np.interp(np.arange(len(raw_master)), render_wav, render_stamps) - config["selectedDeadlineMs"] * 48
            source_positions, reference_available = source_frames_from_clock(expected_stamps, effective_stamps, source_wav)
            source_seconds = source_positions / pcm["senderMic"][1]["sampleRate"]
        else:
            shift = float(np.median([row["sourceFileSeconds"] - row["receiverFileSeconds"] for row in all_accepted]))
            source_seconds = np.arange(len(raw_master)) / header["sampleRate"] + shift
        idx = np.clip((np.nan_to_num(source_seconds) / .02).astype(int), 0, len(db) - 1)
        active = ((db[idx] > threshold) & (source_seconds >= config.get("senderActiveFromSeconds", 0)))
        if approved:
            in_song = (np.arange(len(raw_master)) / header["sampleRate"] + offset < duration)
            active &= reference_available & in_song
            output["referenceCoverage"] = {"evaluatedNativeFrames": int((reference_available & in_song).sum()),
                                            "unavailableNativeFrames": int((~reference_available & in_song).sum()),
                                            "nativeRate": header["sampleRate"],
                                            "note": "Unavailable reference samples are excluded and explicitly reported, never endpoint-clamped into activity."}
            one_second_native = np.minimum((np.arange(0, len(residual), a.RATE) / a.RATE * header["sampleRate"]).astype(int), len(source_seconds) - 1)
            clock_starts = source_seconds[one_second_native] * a.RATE
            frame_centers_native = np.minimum(((np.arange(len(residual) // frame) + .5) * .02 * header["sampleRate"]).astype(int), len(active) - 1)
            clock_active_frames = active[frame_centers_native]
            output["matchedVoicePresence"] = match_song_presence(residual, sender, clock_starts,
                clock_active_frames, a.RATE, noise_db, raw_master - raw_backing, header["sampleRate"], offset,
                native_source_active=active)
        output["nativeSilenceDiagnostic"] = a.native_missing_intervals(raw_master - raw_backing, active,
                                                                      header["sampleRate"], offset)
        output["nativeSilenceDiagnostic"]["scope"] = "DIAGNOSTIC_ONLY: short-window source activity mapping; strict primary result unchanged"
        if approved:
            output["nativeSilenceDiagnostic"]["scope"] = "USER_APPROVED_1S: real-mic activity comes from packet clock minus selected room deadline; no waveform stretching"
    if approved:
        output.update(primary_report({name: value["summary"] for name, value in output["windows"].items()}))
        output["backingConfidenceStatus"] = ("PASS" if all(value["summary"]["backingAcceptedVoicedFraction"] == 1
                                                          for value in output["windows"].values()) else "FAIL")
        output["status"] = ("PASS" if output["confidenceStatus"] == "PASS" and
                            output["backingConfidenceStatus"] == "PASS" and not output["drift"]["detected"] else "FAIL")
        output["gateMeaning"] = "Voice identification and measured drift gate; raw missing intervals are reported separately, without an invented subjective audibility limit."
        output["dropouts"] = output.get("matchedVoicePresence")
        if output["dropouts"] is None or output["dropouts"]["status"] != "MEASURED":
            output["status"] = "FAIL"
            output["continuityConfidence"] = "INDETERMINATE"
        else:
            output["continuityConfidence"] = "MEASURED"
    output_path.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps({"scope": output["scope"], "strictPrimaryStatus": output["strictPrimaryStatus"],
                      "windows": {name: value["summary"] for name, value in output["windows"].items()}}, indent=2))


if __name__ == "__main__":
    main()
