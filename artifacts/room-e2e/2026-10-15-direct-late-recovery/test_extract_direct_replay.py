"""Offline fixture extraction; these packets never replace a physical microphone."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import wave


spec = importlib.util.spec_from_file_location(
    "extract_direct_replay", Path(__file__).with_name("extract_direct_replay.py"))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class DirectReplayExtraction(unittest.TestCase):
    def trace(self, sequence, musical=1000, arrival=10000, **values):
        fields = {"generation": 1, "streamEpoch": 7, "sequence": sequence,
                  "musicalFrame": musical, "socketReceiveMicros": arrival,
                  "socketTimelineFrame": musical + 200,
                  "decisionTimelineFrame": musical + 210,
                  "targetDelayFrames": 2640,
                  "targetPresentationFrame": musical + 2640,
                  "queueFillFrames": 2500, "lateSkipFrames": 0,
                  "decision": "QUEUED"}
        fields.update(values)
        return "RemotePacketTrace.peer: " + ";".join(f"{k}={v}" for k, v in fields.items())

    def timeline(self, wav_offset, room_frame, frames=120, capture=None):
        return {"wavOffsetFrames": wav_offset, "timelineFrame": room_frame,
                "frames": frames, "sampleRateHz": 48000, "roomClockValid": 1,
                "captureTimelineFrame": room_frame if capture is None else capture,
                "captureEndTimelineFrame": room_frame + frames if capture is None else capture + frames,
                "timelineSampleRateHz": 48000}

    def test_repeated_trace_keys_are_not_overwritten_and_frozen_snapshots_deduplicate(self):
        a, b = self.trace(12, arrival=20000), self.trace(13, musical=1120, arrival=19500)
        raw = "0|MonotonicTicks: 123\n" + a + "\n" + b + "\n" + a + "\n"
        parsed = extract.parse_packet_traces([raw], "peer")
        self.assertEqual([p["sequence"] for p in parsed], [13, 12])
        self.assertEqual([p["socketReceiveMicros"] for p in parsed], [19500, 20000])

    def test_actual_raw_jsonl_envelope_preserves_every_trace_line(self):
        first = self.trace(1) + "\r\n" + self.trace(2, musical=1120)
        raw = "\n".join(json.dumps({"at": "2026-10-15T19:45:02Z", "raw": body})
                        for body in (first, self.trace(2, musical=1120)))
        packets = extract.parse_packet_traces([raw], "peer")
        self.assertEqual([row["sequence"] for row in packets], [1, 2])

    def test_disjoint_frozen_windows_are_not_claimed_as_one_network_stall(self):
        raw = "\n".join(json.dumps({"at": at, "raw": body}) for at, body in (
            ("2026-10-15T19:45:02Z", self.trace(1)),
            ("2026-10-15T19:45:07Z", self.trace(667, musical=80920, arrival=1681000))))
        packets = extract.parse_packet_traces([raw], "peer")
        result = extract.build_fixture(packets, [], [])
        self.assertEqual(len(result["traceSegments"]), 2)
        self.assertTrue(result["packets"][1]["traceCoverageBoundaryBefore"])

    def test_native_csv_and_binary_reference_payload_have_explicit_offsets(self):
        packet = extract.parse_packet_traces([self.trace(1)], "peer")
        result = extract.build_fixture(packet, [self.timeline(0, 1000)], [])
        result["packets"][0]["sourcePcm16"] = [10, -20, 30]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            extract.write_fixture(result, path)
            import csv
            with path.with_suffix(".csv").open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["arrivalOffsetMicros"], "0")
            self.assertEqual(rows[0]["timestampFrame"], "1000")
            self.assertEqual(rows[0]["originalDecision"], "QUEUED")
            self.assertEqual(rows[0]["pcm16OffsetSamples"], "0")
            self.assertEqual(rows[0]["pcm16Samples"], "3")
            self.assertEqual(path.with_suffix(".pcm16").read_bytes(), b"\x0a\x00\xec\xff\x1e\x00")

    def test_native_render_csv_preserves_actual_presentation_block_stamps(self):
        import csv
        packet = extract.parse_packet_traces([self.trace(1)], "peer")
        blocks = [self.timeline(0, 3520, 120), self.timeline(120, 3750, 120)]
        result = extract.build_fixture(packet, [], blocks)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            extract.write_fixture(result, path)
            with path.with_suffix(".render.csv").open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual([int(row["timelineFrame"]) for row in rows], [3520, 3750])

    def test_conflicting_same_epoch_sequence_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "conflicting"):
            extract.parse_packet_traces([self.trace(1) + "\n" + self.trace(1, arrival=11000)], "peer")

    def test_other_peer_and_new_epoch_do_not_collide(self):
        raw = self.trace(1) + "\n" + self.trace(1, streamEpoch=8) + "\n" + self.trace(2).replace(".peer:", ".other:")
        parsed = extract.parse_packet_traces([raw], "peer")
        self.assertEqual(len(parsed), 2)
        self.assertEqual([p["streamEpoch"] for p in parsed], [7, 8])

    def test_exact_source_packet_and_piecewise_master_mapping(self):
        packet = extract.parse_packet_traces([self.trace(1, musical=1120)], "peer")
        sender = [self.timeline(0, 1000), self.timeline(120, 1120, capture=1107)]
        # A measured clock step: extrapolating from the first master row would be wrong.
        receiver = [self.timeline(0, 3520, 120), self.timeline(120, 3750, 120)]
        result = extract.build_fixture(packet, sender, receiver)
        row = result["packets"][0]
        self.assertEqual(row["senderWavOffsetFrames"], 120)
        self.assertEqual(row["captureTimelineFrame"], 1107)
        self.assertEqual(row["targetPresentationFrame"], 3760)
        self.assertEqual(row["receiverPresentationWavFrame"], 130)
        self.assertTrue(result["sourceTimelineComplete"])
        self.assertEqual(result["renderBlocks"][1]["timelineFrame"], 3750)

    def test_unrecorded_source_and_target_gaps_are_explicit(self):
        packet = extract.parse_packet_traces([self.trace(1, musical=1120)], "peer")
        sender = [self.timeline(0, 1000)]
        receiver = [self.timeline(0, 3500, 120), self.timeline(120, 3800, 120)]
        result = extract.build_fixture(packet, sender, receiver)
        self.assertFalse(result["sourceTimelineComplete"])
        self.assertIsNone(result["packets"][0]["senderWavOffsetFrames"])
        self.assertIsNone(result["packets"][0]["receiverPresentationWavFrame"])

    def test_pcm_payload_is_exact_native_sender_wav_without_stretch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sender.wav"
            pcm = list(range(-120, 120))
            import struct
            with wave.open(str(path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(48000)
                wav.writeframes(struct.pack("<240h", *pcm))
            packet = extract.parse_packet_traces([self.trace(1, musical=1120)], "peer")
            sender = [self.timeline(0, 1000), self.timeline(120, 1120)]
            result = extract.build_fixture(packet, sender, [], sender_wav=path)
            self.assertEqual(result["packets"][0]["sourcePcm16"], pcm[120:])
            self.assertTrue(result["sourcePcmComplete"])

    def test_invalid_source_clock_is_retained_but_not_complete(self):
        packet = extract.parse_packet_traces([self.trace(1)], "peer")
        source = self.timeline(0, 1000)
        source["roomClockValid"] = 0
        result = extract.build_fixture(packet, [source], [])
        self.assertEqual(result["packets"][0]["senderWavOffsetFrames"], 0)
        self.assertFalse(result["sourceTimelineComplete"])

    def test_unknown_numeric_fields_round_trip_and_missing_arrival_rejected(self):
        raw = self.trace(1, futureCounter=123)
        parsed = extract.parse_packet_traces([raw], "peer")
        self.assertEqual(parsed[0]["futureCounter"], 123)
        with self.assertRaisesRegex(ValueError, "socketReceiveMicros"):
            extract.parse_packet_traces([raw.replace("socketReceiveMicros=10000;", "")], "peer")


if __name__ == "__main__":
    unittest.main()
