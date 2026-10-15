"""Extract actual, opt-in packet decisions without destroying repeated diagnostic keys.

This is an offline evidence adapter, not a network emulator. It preserves observed
arrival/order/timeline coordinates. Missing stages and source coverage stay explicit.
"""
import argparse
import csv
import glob
import hashlib
import json
from pathlib import Path
import struct
import wave


ROOM_RATE = 48000
TRACE_PREFIX = "RemotePacketTrace."
REQUIRED = ("generation", "streamEpoch", "sequence", "musicalFrame", "socketReceiveMicros")


def parse_packet_traces(raw_texts, peer):
    """Keep every repeated trace line and deduplicate repeated frozen snapshots."""
    packets, windows = {}, {}
    prefix = TRACE_PREFIX + peer + ": "
    for raw_index, raw in enumerate(raw_texts):
        lines = []
        for line_index, line in enumerate(raw.splitlines()):
            if line.lstrip().startswith("{"):
                envelope = json.loads(line)
                window = f"{envelope.get('at', 'snapshot')}:{raw_index}:{line_index}"
                lines.extend((item, window) for item in envelope["raw"].splitlines())
            else:
                lines.append((line, f"raw:{raw_index}"))
        for line, window in lines:
            line = line.removeprefix("0|")
            if not line.startswith(prefix):
                continue
            packet = {"participant": peer}
            for item in line[len(prefix):].split(";"):
                key, value = item.split("=", 1)
                try:
                    packet[key] = int(value)
                except ValueError:
                    packet[key] = value
            for key in REQUIRED:
                if key not in packet or not isinstance(packet[key], int):
                    raise ValueError(f"packet trace requires integer {key}")
            key = tuple(packet[field] for field in ("generation", "streamEpoch", "sequence"))
            if key in packets and packet != packets[key]:
                raise ValueError(f"conflicting packet trace for {peer} generation/epoch/sequence {key}")
            packets[key] = packet
            windows.setdefault(key, set()).add(window)
    for key, packet in packets.items():
        packet["traceWindowIds"] = sorted(windows[key])
    return sorted(packets.values(), key=lambda packet: (
        packet["socketReceiveMicros"], packet["streamEpoch"], packet["sequence"]))


def read_timeline(path):
    with Path(path).open(newline="", encoding="utf-8-sig") as handle:
        rows = [{key: int(value) for key, value in row.items()} for row in csv.DictReader(handle)]
    offset = 0
    for row in rows:
        if row["wavOffsetFrames"] != offset or row["frames"] <= 0:
            raise ValueError(f"noncontiguous WAV timeline at {offset}: {path}")
        if row.get("timelineSampleRateHz", ROOM_RATE) != ROOM_RATE:
            raise ValueError(f"unsupported room timeline rate: {path}")
        offset += row["frames"]
    return rows


def build_fixture(packets, sender_timeline, receiver_timeline, sender_wav=None, codec=None):
    source_by_frame = {}
    for row in sender_timeline:
        if row["timelineFrame"] in source_by_frame:
            raise ValueError(f"ambiguous sender effective timeline frame {row['timelineFrame']}")
        source_by_frame[row["timelineFrame"]] = row
    arrival_origin = min((packet["socketReceiveMicros"] for packet in packets), default=0)
    targets = [packet["targetPresentationFrame"] for packet in packets
               if "targetPresentationFrame" in packet]
    # Retain measured presentation blocks around the captured burst, including warm-up/recovery.
    first = min(targets, default=0) - ROOM_RATE // 2
    last = max(targets, default=0) + ROOM_RATE // 2
    render_blocks = [dict(row) for row in receiver_timeline
                     if row["timelineFrame"] <= last and row["timelineFrame"] +
                     row["frames"] * ROOM_RATE / row["sampleRateHz"] >= first]
    output, segments, previous_windows = [], [], set()
    source_complete = bool(packets)
    pcm_complete = bool(packets) and sender_wav is not None
    wav = wave.open(str(sender_wav), "rb") if sender_wav is not None else None
    try:
        if wav is not None and (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) != (1, 2, ROOM_RATE):
            raise ValueError("sender reference must be mono PCM16 at 48000 Hz")
        for packet in packets:
            row = dict(packet)
            packet_windows = set(packet.get("traceWindowIds", ()))
            boundary = bool(output and packet_windows and not packet_windows.intersection(previous_windows))
            if not output or boundary:
                segments.append({"startPacketIndex": len(output), "endPacketIndexInclusive": len(output),
                                 "note": "Only observed decisions within a trace snapshot; boundary gaps are unknown capture coverage, not observed network loss."})
            segments[-1]["endPacketIndexInclusive"] = len(output)
            row["traceSegmentId"] = len(segments) - 1
            row["traceCoverageBoundaryBefore"] = boundary
            previous_windows = packet_windows
            row["arrivalMicrosFromFirst"] = packet["socketReceiveMicros"] - arrival_origin
            row["arrivalOffsetMicros"] = row["arrivalMicrosFromFirst"]
            row["timestampFrame"] = packet["musicalFrame"]
            row["originalDecision"] = packet.get("decision", "UNKNOWN")
            row["codec"] = {"Opus": 0, "Pcm16": 1, None: None}[codec]
            source = source_by_frame.get(packet["musicalFrame"])
            row["senderWavOffsetFrames"] = source["wavOffsetFrames"] if source else None
            row["sourcePcm16"] = None
            source_valid = bool(source and source["roomClockValid"] and
                                source["captureEndTimelineFrame"] > source["captureTimelineFrame"])
            row["sourceClockValid"] = source_valid
            source_complete &= source_valid
            if source:
                row.update({key: source[key] for key in (
                    "captureTimelineFrame", "captureEndTimelineFrame", "frames", "sampleRateHz")})
                if source["sampleRateHz"] != ROOM_RATE:
                    raise ValueError("network reference is not at the transport sample rate")
                if wav is not None:
                    wav.setpos(source["wavOffsetFrames"])
                    raw = wav.readframes(source["frames"])
                    if len(raw) != source["frames"] * 2:
                        raise ValueError("source packet extends beyond sender WAV")
                    row["sourcePcm16"] = list(struct.unpack(f"<{source['frames']}h", raw))
            else:
                pcm_complete = False
            row["receiverPresentationWavFrame"] = None
            target = packet.get("targetPresentationFrame")
            if target is not None:
                matches = [block for block in render_blocks if block["roomClockValid"] and
                           block["timelineFrame"] <= target < block["timelineFrame"] +
                           block["frames"] * ROOM_RATE / block["sampleRateHz"]]
                if len(matches) == 1:
                    block = matches[0]
                    row["receiverPresentationWavFrame"] = block["wavOffsetFrames"] + (
                        target - block["timelineFrame"]) * block["sampleRateHz"] / ROOM_RATE
                elif len(matches) > 1:
                    row["receiverPresentationMappingAmbiguous"] = True
            output.append(row)
    finally:
        if wav is not None:
            wav.close()
    return {"schema": "advoice-direct-packet-replay-v1", "roomRateHz": ROOM_RATE,
            "voiceCodec": codec, "codecSource": "Explicit CLI; verify sender diagnostics, trace does not include codec",
            "arrivalOriginMicros": arrival_origin, "packetCount": len(output),
            "sourceTimelineComplete": source_complete, "sourcePcmComplete": pcm_complete,
            "captureScope": "Existing 96-event delivered-packet decision ring; actual observed socket arrival times. Not a complete raw socket/reorder/render-call trace.",
            "missingEvidence": ["raw receive rejects/duplicates", "JitterPopOutcome::Lost events",
                                "actual renderRemote call times", "direct send success per sequence"],
            "sourcePcmNote": "PCM16 sender reference at exact effective timeline stamp. This is reference WAV PCM, not a captured encoded datagram payload.",
            "packets": output, "traceSegments": segments, "renderBlocks": render_blocks}


def write_fixture(result, output):
    """Write JSON plus dependency-free native CSV and concatenated LE PCM16 reference."""
    output = Path(output)
    binary = bytearray()
    mapped = []
    for packet in result["packets"]:
        pcm = packet.get("sourcePcm16")
        packet["pcm16OffsetSamples"] = len(binary) // 2 if pcm is not None else None
        packet["pcm16Samples"] = len(pcm) if pcm is not None else 0
        if pcm is not None:
            binary.extend(struct.pack(f"<{len(pcm)}h", *pcm))
            if packet["sourceClockValid"]:
                mapped.append(packet)
    result["mappedPacketCount"] = len(mapped)
    result["mappedSubsetOnly"] = len(mapped) != len(result["packets"])
    result["nativeReferencePcmFile"] = output.with_suffix(".pcm16").name
    output.with_suffix(".pcm16").write_bytes(binary)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    first_fields = ["arrivalOffsetMicros", "sequence", "timestampFrame", "frames", "codec",
                    "originalDecision", "pcm16OffsetSamples", "pcm16Samples"]
    excluded = {"sourcePcm16", "traceWindowIds"}
    fields = first_fields + sorted({key for packet in result["packets"] for key in packet
                                    if key not in excluded and key not in first_fields})
    for path, packets in ((output.with_suffix(".csv"), result["packets"]),
                          (output.with_suffix(".mapped.csv"), mapped)):
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows({key: int(value) if isinstance(value, bool) else value
                              for key, value in packet.items() if key not in excluded}
                             for packet in packets)
    render_fields = ["wavOffsetFrames", "timelineFrame", "frames", "sampleRateHz", "roomClockValid",
                     "captureTimelineFrame", "captureEndTimelineFrame", "timelineSampleRateHz"]
    with output.with_suffix(".render.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=render_fields)
        writer.writeheader()
        writer.writerows(result["renderBlocks"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diagnostics", action="append", required=True,
                        help="Raw GetDiagnostics file or glob; repeat for multiple snapshots")
    parser.add_argument("--peer", required=True)
    parser.add_argument("--sender-timeline", required=True)
    parser.add_argument("--receiver-timeline", required=True)
    parser.add_argument("--sender-wav")
    parser.add_argument("--codec", choices=("Pcm16", "Opus"),
                        help="Confirmed sender codec; trace itself does not record this field")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    paths = sorted({Path(path) for pattern in args.diagnostics for path in glob.glob(pattern)})
    if not paths:
        parser.error("no raw diagnostic files matched")
    packets = parse_packet_traces([path.read_text(encoding="utf-8-sig") for path in paths], args.peer)
    if not packets:
        parser.error("no packet trace rows for peer; enable AD_VOICE_ROOM_PACKET_TRACE=1 before starting AudioService")
    result = build_fixture(packets, read_timeline(args.sender_timeline),
                           read_timeline(args.receiver_timeline), args.sender_wav, args.codec)
    inputs = paths + [Path(args.sender_timeline), Path(args.receiver_timeline)]
    if args.sender_wav:
        inputs.append(Path(args.sender_wav))
    result["inputs"] = [{"path": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                        for path in inputs]
    write_fixture(result, args.output)
    print(json.dumps({key: result[key] for key in (
        "packetCount", "arrivalOriginMicros", "sourceTimelineComplete", "sourcePcmComplete")}))


if __name__ == "__main__":
    main()
