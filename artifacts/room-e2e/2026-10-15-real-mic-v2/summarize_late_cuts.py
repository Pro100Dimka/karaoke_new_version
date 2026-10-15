"""Read saved per-stream diagnostics; never interpret packet cuts as audible dropout durations."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / "2026-10-15-1919-room-deadline"
COUNTERS = (
    "RemoteLateAudioCuts", "RemoteLateNonzeroVoiceCuts", "RemoteLateEmptyMixPackets",
    "RemoteLateOtherAudioCuts", "RemoteRenderedNonzeroBlocks", "RemoteDirectFirstPackets",
    "RemoteRelayFirstPackets", "RemoteDecodedNonzeroPackets", "RemoteQueuedNonzeroPackets",
)
CONFIG_FIELDS = (
    "Backend", "RuntimeInputSampleRate", "RuntimeOutputSampleRate", "RuntimeInputPeriodFrames",
    "RuntimeOutputPeriodFrames", "InputMode", "OutputMode", "LowLatencyMicrophoneRequested",
    "LowLatencyMicrophoneActive", "LowLatencyMicrophoneFallback", "MonitoringEnabled",
    "DiagnosticInputMode", "MicrophoneEnabled", "AsioSelectedInputChannel", "SystemVolumeGain", "InputClipping",
)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_jsonl(path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                # A live capture can still be appending its last row. A rerun reads its completion.
                continue
    return rows


def number(diag, field, stream):
    raw = diag.get(f"{field}.{stream}")
    return float(raw) if raw is not None else None


def summarize(label, evidence_path, rows, complete):
    rows = sorted({r["at"]: r for r in rows if r.get("at")}.values(), key=lambda r: r["at"])
    initial_room = rows[0].get("room", {})
    epoch = (initial_room.get("songId"), initial_room.get("playbackStartedAt"))
    def original_epoch(row):
        room = row.get("room", {})
        return (room.get("songId"), room.get("playbackStartedAt")) == epoch
    result = {"label": label, "evidence": str(evidence_path.relative_to(HERE.parent)),
              "complete": complete, "start": rows[0]["at"], "end": rows[-1]["at"],
              "snapshotCount": len(rows), "deadlinesMs": sorted({
                  r.get("room", {}).get("roomPlayoutDelayMs", r.get("room", {}).get("deadlineMs"))
                  for r in rows if r.get("room", {}).get("roomPlayoutDelayMs", r.get("room", {}).get("deadlineMs")) is not None}),
              "deadlinesWhilePlayingMs": sorted({
                  r.get("room", {}).get("roomPlayoutDelayMs", r.get("room", {}).get("deadlineMs"))
                  for r in rows if r.get("room", {}).get("playbackState") == "Playing" and
                  r.get("room", {}).get("roomPlayoutDelayMs", r.get("room", {}).get("deadlineMs")) is not None}),
              "originalPlaybackStartedAt": epoch[1],
              "deadlinesDuringOriginalPlaybackMs": sorted({
                  r.get("room", {}).get("roomPlayoutDelayMs", r.get("room", {}).get("deadlineMs"))
                  for r in rows if original_epoch(r) and r.get("room", {}).get("playbackState") == "Playing" and
                  r.get("room", {}).get("roomPlayoutDelayMs", r.get("room", {}).get("deadlineMs")) is not None}),
              "deadlineNote": "Use deadlinesDuringOriginalPlaybackMs: stopped conversation or a new playbackStartedAt after the recorded song are separate epochs, not a deadline change during that song.",
              "sides": {}}
    result["physicalConfiguration"] = {}
    for side in ("host", "laptop"):
        config = {field: sorted({r[side][field] for r in rows if field in r.get(side, {})})
                  for field in CONFIG_FIELDS}
        peaks = [float(r[side]["InputPeak"]) for r in rows if "InputPeak" in r.get(side, {})]
        config["sampledInputPeakRange"] = [min(peaks), max(peaks)] if peaks else None
        result["physicalConfiguration"][side] = config
        streams = sorted({k.split(".", 1)[1] for r in rows for k in r.get(side, {})
                          if k.startswith("RemoteLateAudioCuts.")})
        summaries = []
        for stream in streams:
            available = [r for r in rows if f"RemoteLateAudioCuts.{stream}" in r.get(side, {})]
            first, last = available[0][side], available[-1][side]
            muted = sorted({r[side].get(f"RemoteMuted.{stream}") for r in available})
            gains = sorted({r[side].get(f"RemoteGain.{stream}") for r in available})
            deltas, resets = {}, []
            for counter in COUNTERS:
                values = [number(r[side], counter, stream) for r in available]
                if any(v is None for v in values):
                    continue
                if any(b < a for a, b in zip(values, values[1:])):
                    resets.append(counter)
                deltas[counter] = {"before": int(values[0]), "after": int(values[-1]),
                                   "delta": int(values[-1] - values[0])}
            summary = {"stream": stream, "isServerMix": stream == "__room_server_mix__",
                       "mutedValues": muted, "gainValues": gains,
                       "excludedFromAudibleMixAtEverySnapshot": muted == ["1"] or gains == ["0"],
                       "counterResets": resets, "counters": deltas, "observations": []}
            for row in available:
                d = row[side]
                summary["observations"].append({
                    "at": row["at"], "muted": d.get(f"RemoteMuted.{stream}"),
                    "roomState": row.get("room", {}).get("playbackState"),
                    "originalPlaybackEpoch": original_epoch(row),
                    "playbackStartedAt": row.get("room", {}).get("playbackStartedAt"),
                    "roomDeadlineMs": row.get("room", {}).get("roomPlayoutDelayMs", row.get("room", {}).get("deadlineMs")),
                    "gain": d.get(f"RemoteGain.{stream}"),
                    "lateCuts": int(number(d, "RemoteLateAudioCuts", stream)),
                    "nonzeroCuts": int(number(d, "RemoteLateNonzeroVoiceCuts", stream)),
                    "emptyMixCuts": int(number(d, "RemoteLateEmptyMixPackets", stream)),
                    "otherCuts": int(number(d, "RemoteLateOtherAudioCuts", stream)),
                    "renderedNonzeroBlocks": int(number(d, "RemoteRenderedNonzeroBlocks", stream)),
                })
            state_deltas = {"PlayingToPlaying": 0, "StoppedToStopped": 0, "TransitionOrUnknown": 0}
            for before, after in zip(summary["observations"], summary["observations"][1:]):
                pair = (before["roomState"], after["roomState"])
                category = {("Playing", "Playing"): "PlayingToPlaying",
                            ("Stopped", "Stopped"): "StoppedToStopped"}.get(pair, "TransitionOrUnknown")
                state_deltas[category] += after["lateCuts"] - before["lateCuts"]
            summary["cutsByObservedPlaybackInterval"] = state_deltas
            epoch_deltas = {"OriginalToOriginal": 0, "LaterEpochToLaterEpoch": 0, "EpochTransition": 0}
            for before, after in zip(summary["observations"], summary["observations"][1:]):
                category = ("OriginalToOriginal" if before["originalPlaybackEpoch"] and after["originalPlaybackEpoch"]
                            else "LaterEpochToLaterEpoch" if not before["originalPlaybackEpoch"] and not after["originalPlaybackEpoch"]
                            else "EpochTransition")
                epoch_deltas[category] += after["lateCuts"] - before["lateCuts"]
            summary["cutsByOriginalPlaybackEpochInterval"] = epoch_deltas
            summaries.append(summary)
        result["sides"][side] = summaries
    return result


def main():
    old_evidence = read_json(OLD / "host-to-laptop-final-evidence.json")
    interval = old_evidence["counterInterval"]
    old_rows = read_jsonl(OLD / "repeatA-selected.jsonl") + read_jsonl(OLD / "repeatA-end.jsonl")
    old_rows += [r for r in read_jsonl(OLD / "physical-diagnostics.jsonl")
                 if interval["start"] <= r["at"] <= interval["end"]]
    runs = [summarize("historical-host-to-laptop-1445", OLD / "host-to-laptop-final-evidence.json",
                      old_rows, True)]
    for label in ("host-to-laptop-v2", "host-to-laptop-final", "laptop-to-host-final", "laptop-to-host-repeat",
                  "ui-host-to-laptop", "ui-laptop-to-host", "ui-host-to-laptop-repeat",
                  "ui-laptop-to-host-repeat"):
        evidence_path = HERE / f"{label}-evidence.json"
        if not evidence_path.exists():
            continue
        evidence = read_json(evidence_path)
        rows = read_jsonl(HERE / f"{label}-diagnostics.jsonl")
        rows += [evidence[key] for key in ("before", "after") if key in evidence]
        summary = summarize(label, evidence_path, rows, "after" in evidence)
        summary["recordingMetadata"] = {}
        for side, stop in evidence.get("stop", {}).items():
            raw = stop.get("metadata", "")
            if raw.startswith("0|"):
                metadata, _ = json.JSONDecoder().raw_decode(raw[2:])
                summary["recordingMetadata"][side] = metadata
        summary["acceptanceRole"] = {
            "host-to-laptop-final": "earlier diagnostic take; superseded by fresh UI direction A repetition",
            "laptop-to-host-repeat": "earlier diagnostic take; superseded by fresh UI direction B repetition",
            "laptop-to-host-final": "excluded: receiver direct-peer gain changed from 1 to 2 during the song",
            "ui-host-to-laptop": "additional fresh UI direction A cuts evidence; first required window lacks its beginning, superseded for final acceptance",
            "ui-laptop-to-host": "timing-valid additional UI take; NOISE_CALIBRATION_INVALID because sender Music=1 during the quiet lead, so 5.58s activity cannot certify whole-song continuity",
            "ui-host-to-laptop-repeat": "replacement fresh UI direction A repetition; only complete files are candidates for final waveform acceptance",
            "ui-laptop-to-host-repeat": "replacement fresh UI direction B repetition; only complete files are candidates for final waveform acceptance",
        }.get(label, "earlier diagnostic take")
        waveform_path = HERE / f"{label}-segmented-result.json"
        if summary["complete"] and waveform_path.exists():
            waveform = read_json(waveform_path)
            receiver = "host" if "laptop-to-host" in label else "laptop"
            audible = [stream for stream in summary["sides"][receiver]
                       if not stream["excludedFromAudibleMixAtEverySnapshot"] and not stream["isServerMix"]]
            summary["waveformVsDirectPacketCuts"] = {
                "waveformResult": waveform_path.name,
                "waveformStatus": waveform.get("status"),
                "continuityConfidence": waveform.get("continuityConfidence"),
                "matchedVoicePresence": {key: waveform.get("matchedVoicePresence", {}).get(key)
                                         for key in ("status", "count", "longestMs", "totalMissingMs", "unidentifiedTotalMs")},
                "nativeDigitalSilenceAtLeast1ms": waveform.get("nativeSilenceDiagnostic", {}).get("packetScaleSilence"),
                "unmutedDirectStreams": [{"stream": stream["stream"],
                                          "packetCutDeltaFullCapture": stream["counters"]["RemoteLateAudioCuts"]["delta"],
                                          "packetCutDeltaByOriginalEpoch": stream["cutsByOriginalPlaybackEpochInterval"]}
                                         for stream in audible],
                "interpretation": "Affected packet counts and waveform-missing intervals are different units. "
                                  "Only the real-microphone waveform analysis establishes missing durations; "
                                  "muted server-mix cuts are excluded. At-least-1ms digital silence is not itself "
                                  "a human audibility threshold. An indeterminate waveform status is not zero dropouts.",
            }
        runs.append(summary)
    output = {"method": "Counters are deltas of exact per-stream keys; muted streams are excluded. "
                        "NonzeroVoice means decoded packet peak > 0, including microphone noise; "
                        "it is not a perceptual voice gate. Counter units are affected packets, "
                        "possibly partly cut, not audible intervals or missing duration.",
              "historicalConclusion": "The +1445 belongs to laptop's unmuted direct host peer "
                                      "b3fa1990ed540274e974103b79e33558, not the muted server mix. "
                                      "All 13 saved snapshots show mute=0/gain=1; nonzero cut delta is "
                                      "also 1445. No sender real-mic reference or packet trace exists "
                                      "for that historical take, so audible-versus-noise and durations "
                                      "cannot be retrospectively established from these counters.",
              "requiredFinalRunLabels": {"hostToLaptop": "ui-host-to-laptop-repeat",
                                         "laptopToHost": "ui-laptop-to-host-repeat"},
              "selectedFinalRuns": {
                  direction: next((run["label"] for run in runs if run["label"] == label and run["complete"]), None)
                  for direction, label in (("hostToLaptop", "ui-host-to-laptop-repeat"),
                                           ("laptopToHost", "ui-laptop-to-host-repeat"))}, "runs": runs}
    (HERE / "cut-summary.json").write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    for run in runs:
        receiver = "host" if "laptop-to-host" in run["label"] else "laptop"
        print(run["label"], "complete=" + str(run["complete"]), run["start"], run["end"])
        for stream in run["sides"][receiver]:
            print(" ", receiver, stream["stream"], "muted=" + str(stream["mutedValues"]),
                  {k: v["delta"] for k, v in stream["counters"].items() if "Cuts" in k or "Packets" in k})


if __name__ == "__main__":
    main()
