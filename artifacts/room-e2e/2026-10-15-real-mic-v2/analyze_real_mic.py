"""Offline physical live-gate analysis. Never injects audio into an application.

python analyze_real_mic.py config.json result.json
Required WAVs: receiverMaster, senderMic, backing. studioVocal is comparison only.
The original TEST_PLAN and its 0.2 NCC threshold remain unchanged.
"""
import json
import csv
from pathlib import Path
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, correlate, find_peaks, resample_poly, sosfiltfilt

RATE = 8000
NCC_GATE = .2


def read_channel(path, channel=0, resample=True):
    pcm, rate = sf.read(path, dtype="float64", always_2d=True)
    if not 0 <= channel < pcm.shape[1]:
        raise ValueError(f"invalid channel {channel}: {path} has {pcm.shape[1]} channels")
    rms = np.sqrt(np.mean(pcm * pcm, axis=0))
    chosen = pcm[:, channel]
    return (resample_poly(chosen, RATE, rate) if resample and rate != RATE else chosen,
            {"path": str(path), "sampleRate": rate, "frames": len(pcm),
             "channels": pcm.shape[1], "selectedChannel": channel,
             "channelRms": rms.tolist(), "peak": float(np.max(np.abs(chosen))),
             "fullScaleSampleFraction": float(np.mean(np.abs(chosen) >= 1 - 1 / 32768))})


def locate(segment, reference, start, stop, rate, polarity_free=True, backing=False):
    """True locally normalized, DC-removed NCC; positions are in caller samples.

    Backing initially uses raw 4 kHz PCM, as in TEST_PLAN. The 8 kHz vocal
    representation preserves 300–3400 Hz; constant 6x interpolation searches
    fractional lag at 48 kHz without changing either waveform's time scale.
    """
    if backing and rate == RATE:
        result = locate(resample_poly(segment, 1, 2), resample_poly(reference, 1, 2),
                        int(start) // 2, (int(stop) + 1) // 2, rate // 2,
                        polarity_free=False)
        if result["position"] is not None:
            result["position"] *= 2
        return result
    start = max(0, int(start))
    stop = min(len(reference) - len(segment) + 1, int(stop))
    empty = {"position": None, "ncc": 0.0, "signedNcc": 0.0,
             "floor": 0.0, "secondPeakNcc": 0.0, "peakRatio": None,
             "uniquePeak": False, "secondPeakPosition": None}
    if stop <= start or len(segment) < 3:
        return empty
    if rate == RATE and not backing:
        # An integer 8 kHz lag can miss a narrow high-frequency NCC maximum.
        # Search the same entire segment and all competing peaks on one finer
        # grid; refining only the winning coarse peak could hide ambiguity.
        result = locate(resample_poly(segment, 6, 1),
                        resample_poly(reference[start:stop + len(segment)], 6, 1),
                        0, (stop - start) * 6, rate * 6, polarity_free=polarity_free)
        for field in ("position", "secondPeakPosition"):
            if result[field] is not None:
                result[field] = start + result[field] / 6
        return result
    segment = segment - np.mean(segment)
    segment_energy = float(np.dot(segment, segment))
    if segment_energy < 1e-16:
        return empty
    search = reference[start:stop + len(segment) - 1]
    sums = np.r_[0.0, np.cumsum(search)]
    squares = np.r_[0.0, np.cumsum(search * search)]
    energy = np.maximum(squares[len(segment):] - squares[:-len(segment)] -
                        (sums[len(segment):] - sums[:-len(segment)]) ** 2 / len(segment), 0)
    scores = correlate(search, segment, mode="valid", method="fft")
    normalized = np.divide(scores, np.sqrt(energy * segment_energy),
                           out=np.zeros_like(scores), where=energy > 1e-16)
    normalized = np.clip(normalized, -1, 1)
    absolute = np.abs(normalized) if polarity_free else normalized
    best = int(np.argmax(absolute))
    fraction = 0.0
    if 0 < best < len(absolute) - 1:
        a, b, c = absolute[best - 1:best + 2]
        denominator = a - 2 * b + c
        if denominator:
            fraction = float(.5 * (a - c) / denominator)
    # Group the periodic sub-peaks of one voiced event; report separated
    # candidates and their ratio, with no replacement for the 0.2 NCC gate.
    peaks, _ = find_peaks(absolute)
    competitors = [int(i) for i in peaks if abs(i - best) > int(.05 * rate)]
    second = max(competitors, key=lambda i: absolute[i], default=None)
    other = float(absolute[second]) if second is not None else 0.0
    return {"position": start + best + fraction, "ncc": float(absolute[best]),
            "signedNcc": float(normalized[best]), "floor": float(np.median(np.abs(normalized))),
            "secondPeakNcc": other, "peakRatio": float(absolute[best] / max(other, 1e-12)),
            "uniquePeak": bool(other < NCC_GATE),
            "secondPeakPosition": None if second is None else start + second}


def timeline_position(timeline, wav_frame, field):
    """Interpolate measured timestamp spans, retaining independent file origins."""
    if not timeline:
        raise ValueError("exact WAV-to-room timeline metadata is required")
    positions = [row["wavFrame"] for row in timeline]
    if "wavFrames" in timeline[0]:
        index = int(np.searchsorted(positions, wav_frame, side="right")) - 1
        if index < 0 or index >= len(timeline):
            raise ValueError("matched WAV sample is outside measured timestamp spans")
        row = timeline[index]
        relative = wav_frame - row["wavFrame"]
        if not 0 <= relative <= row["wavFrames"]:
            raise ValueError("matched WAV sample is in a timestamp gap")
        if not row["valid"]:
            raise ValueError("matched WAV sample has no valid physical clock anchor")
        return row[field] + relative / row["wavFrames"] * (row["end" + field[0].upper() + field[1:]] - row[field])
    values = [row[field] for row in timeline]
    if len(timeline) == 1:
        raise ValueError("at least two timestamp anchors are required")
    if not positions[0] <= wav_frame <= positions[-1]:
        raise ValueError("matched WAV sample is outside measured timestamp spans")
    return float(np.interp(wav_frame, positions, values))


def read_timeline(path, role, wav_frames, wav_rate):
    """Read exact tap CSV, preserving each packet's measured physical span."""
    with open(path, newline="", encoding="utf-8-sig") as handle:
        rows = [{key: int(value) for key, value in row.items()}
                for row in csv.DictReader(handle)]
    timeline, offset, jumps, invalid_physical = [], 0, [], 0
    for row in rows:
        if row["wavOffsetFrames"] != offset:
            raise ValueError(f"timeline WAV gap at {offset}: {path}")
        if row["sampleRateHz"] != wav_rate or row["frames"] <= 0:
            raise ValueError(f"invalid WAV rate/frame span: {path}")
        clock_rate = row.get("timelineSampleRateHz", 48000)
        if clock_rate != 48000:
            raise ValueError(f"unexpected room clock rate: {path}")
        frames = row["frames"]
        item = {"wavFrame": offset, "wavFrames": frames, "valid": bool(row["roomClockValid"])}
        if role == "sender":
            item.update({"physicalRoomFrame": row["captureTimelineFrame"],
                         "endPhysicalRoomFrame": row["captureEndTimelineFrame"],
                         "effectiveRoomFrame": row["timelineFrame"],
                         "endEffectiveRoomFrame": row["timelineFrame"] + frames / wav_rate * clock_rate})
            if item["valid"] and item["endPhysicalRoomFrame"] <= item["physicalRoomFrame"]:
                item["valid"] = False
                invalid_physical += 1
            field = "physicalRoomFrame"
        else:
            item.update({"presentationRoomFrame": row["timelineFrame"],
                         "endPresentationRoomFrame": row["timelineFrame"] + frames / wav_rate * clock_rate})
            field = "presentationRoomFrame"
        if timeline:
            previous_end = timeline[-1]["end" + field[0].upper() + field[1:]]
            jumps.append((item[field] - previous_end) / clock_rate * 1000)
        timeline.append(item)
        offset += frames
    if offset != wav_frames or not timeline:
        raise ValueError(f"timestamp coverage {offset} != WAV frames {wav_frames}: {path}")
    return timeline, {"path": str(path), "rows": len(rows), "wavFrames": offset,
                      "invalidRows": sum(not row["valid"] for row in timeline),
                      "invalidPhysicalSpanRows": invalid_physical,
                      "minimumBoundaryJumpMs": min(jumps, default=0),
                      "maximumBoundaryJumpMs": max(jumps, default=0)}


def sender_song_origin(timeline, song_start_room_frame, room_rate):
    return (timeline[0]["physicalRoomFrame"] - song_start_room_frame) / room_rate


def validate_timeline_span(timeline, begin, end):
    """A clock-invalid packet cannot anchor a physical-delay acceptance window."""
    if "wavFrames" not in timeline[0]:
        return
    for row in timeline:
        if row["wavFrame"] < end and row["wavFrame"] + row["wavFrames"] > begin and not row["valid"]:
            raise ValueError("clock-invalid packet overlaps required window")


def fractional_slice(array, begin, count):
    return np.interp(np.arange(count) + begin, np.arange(len(array)), array,
                     left=0.0, right=0.0)


def subtract_backing(segment, backing, position):
    """Refine 4 kHz position by minimizing full 8 kHz LS residual energy."""
    # A short local search eliminates the half-sample phase loss of 4 kHz
    # localization. No signal length, sample clock or song speed is altered.
    positions = np.arange(round(position) - 2.0, round(position) + 2.01, .05)
    best = None
    for candidate in positions:
        aligned = fractional_slice(backing, candidate, len(segment))
        denominator = float(np.dot(aligned, aligned))
        gain = float(np.dot(segment, aligned) / max(denominator, 1e-18))
        residual = segment - gain * aligned
        energy = float(np.dot(residual, residual))
        if best is None or energy < best[0]:
            best = energy, candidate, gain, residual
    _, position, gain, residual = best
    return residual, float(position), gain


def native_missing_intervals(residual, source_active, rate, song_origin):
    """Exact digital silence boundaries in native master-minus-backing PCM.

    Two independent PCM16 recordings can differ by at most two LSBs from
    quantization. No resample or bandpass is used for these event boundaries.
    """
    if len(residual) != len(source_active):
        raise ValueError("native residual and source-activity masks must match")
    missing = source_active & (np.abs(residual) <= 2 / 32768)
    edges = np.flatnonzero(np.diff(np.r_[False, missing, False].astype(np.int8)))
    all_intervals = [{"songSeconds": round(song_origin + begin / rate, 7),
                      "durationMs": round((end - begin) / rate * 1000, 5)}
                     for begin, end in zip(edges[::2], edges[1::2])]
    intervals = [event for event in all_intervals if event["durationMs"] >= 60]
    durations = [event["durationMs"] for event in intervals]
    packet_scale = [event for event in all_intervals if event["durationMs"] >= 1]
    packet_durations = [event["durationMs"] for event in packet_scale]
    histogram = {}
    for name, low, high in (("below1ms", 0, 1), ("1to2_5ms", 1, 2.5),
                            ("2_5to20ms", 2.5, 20), ("20to60ms", 20, 60),
                            ("atLeast60ms", 60, float("inf"))):
        lengths = [event["durationMs"] for event in all_intervals if low <= event["durationMs"] < high]
        histogram[name] = {"count": len(lengths), "totalMs": round(sum(lengths), 5)}
    return {"count": len(intervals), "intervals": intervals,
            "longestMs": max(durations, default=0), "totalMissingMs": round(sum(durations), 5),
            "allDigitalSilence": {"count": len(all_intervals), "intervals": all_intervals,
                                  "totalMs": round(sum(event["durationMs"] for event in all_intervals), 5),
                                  "longestMs": max((event["durationMs"] for event in all_intervals), default=0),
                                  "note": "Includes sample-scale quantized zero crossings; these are not all network losses or audible events."},
            "packetScaleSilence": {"count": len(packet_scale), "intervals": packet_scale,
                                   "totalMs": round(sum(packet_durations), 5), "longestMs": max(packet_durations, default=0),
                                   "minimumReportedMs": 1,
                                   "note": "Digital silence >=1ms during sender activity; engineering diagnostic, not an audibility threshold."},
            "digitalSilenceHistogram": histogram,
            "nativeRate": rate, "digitalSilenceBound": 2 / 32768,
            "boundaryResolutionMs": 1000 / rate}


def missing_intervals(received, expected, rate, song_origin, normal_gain, noise_floor_db,
                      native_received=None, native_rate=None, source_active_frames=None,
                      native_source_active=None):
    """Measure missing matched mic component, not the backing residual's energy.

    20 ms analysis frames / 60 ms event minimum and -35/-30 dB gates are
    retained from TEST_PLAN. Natural sender silence never counts as a loss.
    """
    frame = int(.02 * rate)
    count = min(len(received), len(expected)) // frame
    got = received[:count * frame].reshape(count, frame)
    want = expected[:count * frame].reshape(count, frame)
    energy = np.mean(want * want, axis=1)
    db = 10 * np.log10(energy + 1e-18)
    active = db > np.percentile(db, 30)
    singing_median = float(np.median(db[active])) if active.any() else -180.0
    active_threshold = max(singing_median - 35, noise_floor_db + 10)
    active = db > active_threshold
    if source_active_frames is not None:
        if len(source_active_frames) < count:
            raise ValueError("source activity coverage is shorter than receiver PCM")
        active = np.asarray(source_active_frames[:count], dtype=bool)
    # Packet-grid retime may move an intact waveform by a few milliseconds.
    # Each 20ms frame tests constant shifts +/-5ms; samples are never stretched.
    # Use the matching component, not unrelated backing residual energy.
    radius = int(.005 * rate)
    padded = np.pad(expected[:count * frame], (radius, radius))
    projections, local_ncc = np.zeros(count), np.zeros(count)
    for index in np.flatnonzero(active):
        segment = got[index] * np.sign(normal_gain)
        segment = segment - np.mean(segment)
        segment_energy = float(np.dot(segment, segment))
        context = padded[index * frame:index * frame + frame + radius * 2]
        sums = np.r_[0.0, np.cumsum(context)]
        squares = np.r_[0.0, np.cumsum(context * context)]
        ref_energy = np.maximum(squares[frame:] - squares[:-frame] -
                                (sums[frame:] - sums[:-frame]) ** 2 / frame, 1e-18)
        dots = np.correlate(context, segment, mode="valid")
        ncc = dots / np.sqrt(np.maximum(ref_energy * segment_energy, 1e-18))
        best = int(np.argmax(ncc))
        local_ncc[index] = float(ncc[best])
        projections[index] = dots[best] / ref_energy[best]
    accepted_gains = projections[active & (local_ncc >= NCC_GATE) & (projections > 0)]
    # A 20s dot product underestimates level when intact packet waveforms move
    # slightly. Estimate normal level from locally identified real voice.
    measured_gain = float(np.median(accepted_gains)) if len(accepted_gains) else abs(normal_gain)
    gain_db = 20 * np.log10(np.maximum(projections, 1e-15) / max(measured_gain, 1e-15))
    classifications = {"missing": active & (gain_db < -30),
                       "unidentified": active & (gain_db >= -30) & (local_ncc < NCC_GATE)}
    intervals = {}
    for kind, flags in classifications.items():
        events, run = [], 0
        for index, flag in enumerate(np.r_[flags, False]):
            if flag:
                run += 1
            elif run:
                if run >= 3:
                    events.append({"songSeconds": round(song_origin + (index - run) * .02, 5),
                                   "durationMs": run * 20})
                run = 0
        intervals[kind] = events
    events = intervals["missing"]
    durations = [event["durationMs"] for event in events]
    unknown = intervals["unidentified"]
    result = {"status": "NO_ACTIVE_SENDER_VOICE" if not active.any() else "INDETERMINATE" if unknown else "MEASURED",
            "count": len(events), "intervals": events, "longestMs": max(durations, default=0),
            "totalMissingMs": sum(durations), "senderActiveMs": int(active.sum()) * 20,
            "unidentifiedIntervals": unknown,
            "unidentifiedTotalMs": sum(event["durationMs"] for event in unknown),
            "evaluatedMs": count * 20, "normalRemoteGain": measured_gain * np.sign(normal_gain),
            "windowProjectionGain": normal_gain,
            "acceptedLocalGainP10P50P90": np.percentile(accepted_gains, [10, 50, 90]).tolist() if len(accepted_gains) else None,
            "senderNoiseFloorDb": noise_floor_db, "senderActiveThresholdDb": active_threshold,
            "medianActiveLocalMicNcc": float(np.median(local_ncc[active])) if active.any() else None,
            "localShiftSearchMs": 5,
            "method": "20ms locally aligned real-mic projection; +/-5ms constant shifts; active>max(singingMedian-35dB,measuredNoise+10dB); missing<-30dB; high-energy NCC<.2 is unidentified; event>=60ms"}
    if native_received is not None:
        index = np.minimum((np.arange(len(native_received)) / native_rate * rate / frame).astype(int), count - 1)
        digital = native_missing_intervals(native_received,
            active[index] if native_source_active is None else native_source_active, native_rate, song_origin)
        # Projection detects the requested source; exact PCM bounds locate real
        # silence without the old 20ms-grid false negative at 60ms duration.
        component_only = [event for event in events if not any(
            other["songSeconds"] <= event["songSeconds"] + 1 / native_rate and
            other["songSeconds"] + other["durationMs"] / 1000 >=
            event["songSeconds"] + event["durationMs"] / 1000 - 1 / native_rate
            for other in digital["intervals"])]
        attenuated, unresolved = [], []
        for event in component_only:
            first_frame = max(0, round((event["songSeconds"] - song_origin) / .02))
            last_frame = min(count, first_frame + round(event["durationMs"] / 20))
            (attenuated if np.all(local_ncc[first_frame:last_frame] >= NCC_GATE) else unresolved).append(event)
        result["componentProjectionMissingIntervals"] = events
        result["attenuatedVoiceIntervals"] = attenuated
        result["componentOnlyUnresolvedIntervals"] = unresolved
        result.update(digital)
        if attenuated:
            combined = sorted(digital["intervals"] + attenuated, key=lambda event: event["songSeconds"])
            result.update(count=len(combined), intervals=combined,
                          longestMs=max(event["durationMs"] for event in combined),
                          totalMissingMs=round(sum(event["durationMs"] for event in combined), 5))
        if unresolved:
            result["status"] = "INDETERMINATE"
        result["method"] += "; event bounds refined from native PCM digital silence, <=2 PCM16 LSB"
    return result


def analyze_arrays(master, backing, sender, rate=RATE, sender_song_seconds=0.0,
                   studio=None, sender_timeline=None, receiver_timeline=None,
                   room_rate=48000, sender_native_rate=48000, receiver_native_rate=48000,
                   short=False, sender_noise_seconds=None, sender_active_from_seconds=0,
                   song_start_room_frame=0, rendered_backing=None,
                   native_residual=None, native_rate=None):
    if rendered_backing is not None and len(rendered_backing) != len(master):
        raise ValueError("rendered backing and master must contain the same frames")
    if native_residual is None and rendered_backing is not None:
        native_residual, native_rate = master - rendered_backing, rate
    band = butter(4, [300, 3400], btype="bandpass", fs=rate, output="sos")
    sender_band = sosfiltfilt(band, sender - np.mean(sender))
    if sender_noise_seconds is not None:
        noise_begin, noise_end = [int(value * rate) for value in sender_noise_seconds]
        noise = sender_band[noise_begin:noise_end]
        if len(noise) < int(.5 * rate):
            raise ValueError("at least 0.5 seconds of measured sender room noise required")
        frame = int(.02 * rate)
        energy = np.mean(noise[:len(noise) // frame * frame].reshape(-1, frame) ** 2, axis=1)
        noise_floor_db = float(10 * np.log10(np.percentile(energy, 95) + 1e-18))
    else:
        # Offline numerical fixtures can use their exact known zero floor.
        # The real CLI requires an explicit physically quiet noise interval.
        noise_floor_db = -180.0
    studio_band = None if studio is None else sosfiltfilt(band, studio - np.mean(studio))
    probe_end = len(master)
    if receiver_timeline is not None:
        first_presentation = timeline_position(receiver_timeline, 0, "presentationRoomFrame")
        first_song_seconds = (first_presentation - song_start_room_frame) / room_rate
        probe_end = min(probe_end, max(0, int((len(backing) / rate - first_song_seconds) * rate)))
    probe_length = min(10 * rate, probe_end)
    if not probe_length:
        raise ValueError("recording contains no original-song presentation interval")
    probe_at = max(range(0, max(1, probe_end - probe_length), rate),
                   key=lambda i: np.dot(master[i:i + probe_length], master[i:i + probe_length]))
    global_match = locate(master[probe_at:probe_at + probe_length], backing,
                          0, len(backing), rate, polarity_free=False, backing=True)
    if global_match["position"] is None or global_match["ncc"] < NCC_GATE:
        return {"status": "FAIL", "reason": "local backing not identified",
                "globalBacking": global_match, "medianLagMs": None, "drift": None, "dropouts": None}
    offset = global_match["position"] - probe_at
    duration = len(backing) / rate
    windows = ({"comparison": (max(20, offset / rate + 1), min(40, (offset + len(master)) / rate - 1))}
               if short else {"start": (20, 40), "middle": (duration / 2 - 10, duration / 2 + 10),
                              "end": (duration - 40, duration - 20)})
    result = {"status": "FAIL", "nccGate": NCC_GATE, "analysisRate": rate,
              "backingSource": "exact rendered tap" if rendered_backing is not None else "source stem LS approximation",
              "globalBacking": global_match, "fileStartsAtSongSeconds": offset / rate,
              "windows": {}, "medianLagMs": None, "drift": None, "dropouts": None}
    accepted = []
    for name, (begin, end) in windows.items():
        file_begin, file_end = int(round(begin * rate - offset)), int(round(end * rate - offset))
        if file_begin < 0 or file_end > len(master) or file_end <= file_begin:
            result["windows"][name] = {"status": "outside recording"}
            continue
        segment = master[file_begin:file_end]
        b_match = locate(segment, backing, begin * rate - rate // 2,
                         begin * rate + rate // 2, rate, polarity_free=False, backing=True)
        if b_match["position"] is None or b_match["ncc"] < NCC_GATE:
            result["windows"][name] = {"status": "backing not found", "backing": b_match}
            continue
        if rendered_backing is None:
            residual, b_pos, gain = subtract_backing(segment, backing, b_match["position"])
        else:
            residual = segment - rendered_backing[file_begin:file_end]
            b_pos, gain = b_match["position"], 1.0
        residual = sosfiltfilt(band, residual - np.mean(residual))
        approximate_sender = b_pos - sender_song_seconds * rate
        mic = locate(residual, sender_band, approximate_sender - rate,
                     approximate_sender + rate // 4, rate)
        entry = {"status": "voice not found", "backingNcc": b_match["ncc"],
                 "backingGain": gain, "backingSongSeconds": b_pos / rate,
                 "receiverFileSeconds": file_begin / rate,
                 "micAbsNcc": mic["ncc"], "micSignedNcc": mic["signedNcc"],
                 "micNccFloor": mic["floor"], "secondPeakNcc": mic["secondPeakNcc"],
                 "peakRatio": mic["peakRatio"], "uniquePeak": mic["uniquePeak"]}
        if studio_band is not None:
            old = locate(residual, studio_band, b_pos - rate, b_pos + rate // 4, rate)
            entry["studioComparison"] = {"absNcc": old["ncc"], "secondPeakNcc": old["secondPeakNcc"],
                                          "status": "ok" if old["ncc"] >= NCC_GATE else "voice not found"}
        if mic["ncc"] >= NCC_GATE and not mic["uniquePeak"]:
            entry["status"] = "ambiguous voice peaks"
        if mic["position"] is not None and mic["ncc"] >= NCC_GATE and mic["uniquePeak"]:
            mic_pos = mic["position"]
            if sender_timeline is not None and receiver_timeline is not None:
                try:
                    validate_timeline_span(sender_timeline, mic_pos / rate * sender_native_rate,
                                           (mic_pos + len(segment)) / rate * sender_native_rate)
                    validate_timeline_span(receiver_timeline, file_begin / rate * receiver_native_rate,
                                           file_end / rate * receiver_native_rate)
                    captured = timeline_position(sender_timeline, mic_pos / rate * sender_native_rate,
                                                 "physicalRoomFrame")
                    presented = timeline_position(receiver_timeline, file_begin / rate * receiver_native_rate,
                                                  "presentationRoomFrame")
                    effective = timeline_position(sender_timeline, mic_pos / rate * sender_native_rate,
                                                 "effectiveRoomFrame")
                except ValueError as error:
                    entry["status"] = str(error)
                    result["windows"][name] = entry
                    continue
                physical_lag = (presented - captured) / room_rate * 1000
                entry["effectiveMusicalLagMs"] = (presented - effective) / room_rate * 1000
                entry["captureRoomFrame"] = captured
                entry["presentationRoomFrame"] = presented
                entry["captureSongSeconds"] = (captured - song_start_room_frame) / room_rate
                entry["effectiveVoiceSongSeconds"] = (effective - song_start_room_frame) / room_rate
                entry["physicalCaptureToBackingMs"] = (b_pos / rate - entry["captureSongSeconds"]) * 1000
                entry["effectiveVoiceToBackingMs"] = (b_pos / rate - entry["effectiveVoiceSongSeconds"]) * 1000
                entry["backingPresentationClockOffsetMs"] = (presented - song_start_room_frame) / room_rate * 1000 - b_pos / rate * 1000
            else:
                physical_lag = (b_pos / rate - sender_song_seconds - mic_pos / rate) * 1000
                entry["physicalCaptureToBackingMs"] = physical_lag
            entry.update({"status": "ok", "micToRemoteMs": round(physical_lag, 5),
                          "micFileSeconds": mic_pos / rate})
            expected = fractional_slice(sender_band, mic_pos, len(residual))
            projection_gain = float(np.dot(residual, expected) / max(np.dot(expected, expected), 1e-18))
            accepted.append((name, physical_lag, b_pos - mic_pos, projection_gain))
        result["windows"][name] = entry
    if len(accepted) == len(windows):
        result["status"] = "PASS"
        result["medianLagMs"] = float(np.median([entry[1] for entry in accepted]))
        if not short:
            drift = accepted[-1][1] - accepted[0][1]
            result["drift"] = {"endMinusStartMs": round(drift, 5), "detected": bool(abs(drift) > 5)}
        # Local 10s blocks each use ONE constant correspondence. No clock or
        # waveform time-stretch is introduced between either recording.
        b_global = float(np.median([entry["backingSongSeconds"] - entry["receiverFileSeconds"]
                                    for entry in result["windows"].values()])) * rate
        start = max(0, int(np.ceil(-b_global)))
        stop = min(len(master), int(np.floor(len(backing) - b_global)))
        segment = master[start:stop]
        if rendered_backing is None:
            aligned_backing = fractional_slice(backing, start + b_global, stop - start)
            gain = float(np.dot(segment, aligned_backing) / max(np.dot(aligned_backing, aligned_backing), 1e-18))
            received = sosfiltfilt(band, segment - gain * aligned_backing)
        else:
            received = sosfiltfilt(band, segment - rendered_backing[start:stop])
        expected = np.zeros_like(received)
        normal_offset = float(np.median([entry[2] for entry in accepted]))
        dropout_track = []
        for block_start in range(0, len(received), 10 * rate):
            block = received[block_start:block_start + 10 * rate]
            source_start = start + block_start + b_global - normal_offset
            local = locate(block, sender_band, source_start - int(.05 * rate),
                           source_start + int(.05 * rate), rate)
            # If a whole block is lost, retain the known continuous timing
            # from the three independently identified windows; absence cannot
            # manufacture a new match or become a zero lag.
            source_start = local["position"] if local["ncc"] >= NCC_GATE else source_start
            expected[block_start:block_start + len(block)] = fractional_slice(sender_band, source_start, len(block))
            dropout_track.append({"songSeconds": (start + block_start + b_global) / rate,
                                  "micNcc": local["ncc"], "sourceFileSeconds": source_start / rate,
                                  "localAlignmentFound": bool(local["ncc"] >= NCC_GATE)})
        valid_from = max(0, int((sender_active_from_seconds * rate + normal_offset - b_global) - start))
        received, expected = received[valid_from:], expected[valid_from:]
        native_segment = None
        if native_residual is not None:
            native_begin = round((start + valid_from) / rate * native_rate)
            native_end = min(len(native_residual), native_begin + round(len(received) / rate * native_rate))
            native_segment = native_residual[native_begin:native_end]
        result["dropouts"] = missing_intervals(received, expected, rate,
                                               (start + valid_from + b_global) / rate,
                                               float(np.median([entry[3] for entry in accepted])), noise_floor_db,
                                               native_received=native_segment, native_rate=native_rate)
        result["dropoutAlignmentTrack"] = dropout_track
        result["dropoutConfidenceGate"] = "PASS" if result["dropouts"]["status"] == "MEASURED" else "FAIL"
        if result["dropoutConfidenceGate"] != "PASS":
            result["status"] = "FAIL"
            result["reason"] = "sender-active intervals could not be confidently classified"
    return result


def main():
    config_path, out_path = map(Path, sys.argv[1:3])
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    parent = config_path.parent
    paths = {key: Path(value) if Path(value).is_absolute() else parent / value
             for key, value in config.items() if key in ("receiverMaster", "senderMic", "backing", "studioVocal", "renderedBacking")}
    wavs = {key: read_channel(path, config.get(key + "Channel", 0)) for key, path in paths.items()}
    native_residual, native_rate = None, None
    if "renderedBacking" in wavs:
        first = wavs["receiverMaster"][1]
        second = wavs["renderedBacking"][1]
        if (first["frames"], first["sampleRate"]) != (second["frames"], second["sampleRate"]):
            raise ValueError("paired master/backing native frame count or rate mismatch")
        native_master, _ = read_channel(paths["receiverMaster"], config.get("receiverMasterChannel", 0), resample=False)
        native_backing, _ = read_channel(paths["renderedBacking"], config.get("renderedBackingChannel", 0), resample=False)
        native_residual = native_master - native_backing
        native_rate = first["sampleRate"]
        del native_master, native_backing
    sender_path = paths["senderMic"]
    receiver_path = paths["receiverMaster"]
    sender_timeline, sender_quality = read_timeline(str(sender_path) + ".timeline.csv", "sender",
                                                   wavs["senderMic"][1]["frames"], wavs["senderMic"][1]["sampleRate"])
    receiver_timeline, receiver_quality = read_timeline(str(receiver_path) + ".timeline.csv", "receiver",
                                                       wavs["receiverMaster"][1]["frames"], wavs["receiverMaster"][1]["sampleRate"])
    room_rate = config.get("roomRate", 48000)
    origin = sender_song_origin(sender_timeline, config["songStartRoomFrame"], room_rate)
    result = analyze_arrays(wavs["receiverMaster"][0], wavs["backing"][0], wavs["senderMic"][0],
                            studio=wavs.get("studioVocal", (None,))[0], sender_song_seconds=origin,
                            sender_timeline=sender_timeline, receiver_timeline=receiver_timeline,
                            room_rate=room_rate, sender_native_rate=wavs["senderMic"][1]["sampleRate"],
                            receiver_native_rate=wavs["receiverMaster"][1]["sampleRate"],
                            short=config.get("shortComparison", False),
                            sender_noise_seconds=config["senderNoiseSeconds"],
                            sender_active_from_seconds=config.get("senderActiveFromSeconds", 0),
                            song_start_room_frame=config["songStartRoomFrame"],
                            rendered_backing=wavs.get("renderedBacking", (None,))[0],
                            native_residual=native_residual, native_rate=native_rate)
    result["inputs"] = {key: value[1] for key, value in wavs.items()}
    result["config"] = config
    result["timelineQuality"] = {"sender": sender_quality, "receiver": receiver_quality}
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
