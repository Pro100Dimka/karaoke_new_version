"""Numerical tests only: fixtures never enter the application microphone path."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

import numpy as np
from scipy.signal import butter, sosfiltfilt

spec = importlib.util.spec_from_file_location("real_mic", Path(__file__).with_name("analyze_real_mic.py"))
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class RealMicrophoneAnalysis(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rate = 8000
        rng = np.random.default_rng(331)
        cls.backing = sosfiltfilt(butter(3, 1800, fs=cls.rate, output="sos"), rng.normal(size=100 * cls.rate))
        cls.sender = sosfiltfilt(butter(3, [400, 3000], btype="bandpass", fs=cls.rate, output="sos"), rng.normal(size=100 * cls.rate)) * .2
        cls.sender[45 * cls.rate:46 * cls.rate] = 0  # Natural pause, never dropout.
        cls.delay = .06525
        cls.anchor = 12_000_000_000

    def make_master(self, dropout=None, inverted=False):
        n = np.arange(96 * self.rate)
        source_position = n + 2 * self.rate - self.delay * self.rate
        remote = np.interp(source_position, np.arange(len(self.sender)), self.sender, left=0, right=0)
        if dropout:
            remote[int((dropout[0] - 2) * self.rate):int((dropout[1] - 2) * self.rate)] = 0
        return self.backing[2 * self.rate:98 * self.rate] + (-remote if inverted else remote)

    def analyze(self, master):
        return analysis.analyze_arrays(master, self.backing, self.sender, self.rate,
                                       sender_song_seconds=0.0)

    def test_known_mic_delay_and_backing_alignment(self):
        result = self.analyze(self.make_master())
        self.assertEqual(result["status"], "PASS")
        for window in result["windows"].values():
            self.assertEqual(window["status"], "ok")
            self.assertGreater(window["micAbsNcc"], .95)
            self.assertLess(abs(window["micToRemoteMs"] - self.delay * 1000), .15)
        self.assertLess(abs(result["drift"]["endMinusStartMs"]), .15)

    def test_opposite_polarity_and_channel_preserve_lag(self):
        result = self.analyze(self.make_master(inverted=True))
        self.assertEqual(result["status"], "PASS")
        self.assertLess(abs(result["medianLagMs"] - self.delay * 1000), .15)

    def test_absent_voice_never_gets_secondary_delay_or_drift(self):
        result = self.analyze(self.backing[2 * self.rate:98 * self.rate])
        self.assertEqual(result["status"], "FAIL")
        self.assertIsNone(result["medianLagMs"])
        self.assertIsNone(result["drift"])
        self.assertIsNone(result["dropouts"])
        self.assertTrue(all(w["micAbsNcc"] < .2 for w in result["windows"].values()))

    def test_real_missing_interval_excludes_natural_mic_pause(self):
        result = self.analyze(self.make_master(dropout=(52, 52.32)))
        dropouts = result["dropouts"]
        self.assertEqual(dropouts["count"], 1)
        self.assertLess(abs(dropouts["longestMs"] - 320), 45)
        self.assertLess(abs(dropouts["totalMissingMs"] - 320), 45)
        self.assertTrue(all(abs(event["songSeconds"] - 45) > .5 for event in dropouts["intervals"]))

    def test_wrong_mic_reference_fails_confidence_gate(self):
        result = analysis.analyze_arrays(self.make_master(), self.backing,
                                        np.roll(self.sender, 10 * self.rate), self.rate,
                                        sender_song_seconds=0.0)
        self.assertEqual(result["status"], "FAIL")
        self.assertIsNone(result["medianLagMs"])

    def test_physical_effective_and_backing_coordinates_are_distinct(self):
        room_rate = 48000
        sender_timeline = [{"wavFrame": index * 6,
                            "physicalRoomFrame": self.anchor + index * 6 + .005 * room_rate,
                            "effectiveRoomFrame": self.anchor + index * 6 - .015 * room_rate}
                           for index in (0, len(self.sender))]
        receiver_timeline = [{"wavFrame": index * 6,
                              "presentationRoomFrame": self.anchor + index * 6 + 2.1 * room_rate}
                             for index in (0, 96 * self.rate)]
        result = analysis.analyze_arrays(self.make_master(), self.backing, self.sender, self.rate,
                                        sender_timeline=sender_timeline, receiver_timeline=receiver_timeline,
                                        song_start_room_frame=self.anchor)
        first = result["windows"]["start"]
        self.assertAlmostEqual(first["micToRemoteMs"], 160.25, delta=.15)
        self.assertAlmostEqual(first["effectiveVoiceToBackingMs"], 80.25, delta=.15)
        self.assertAlmostEqual(first["physicalCaptureToBackingMs"], 60.25, delta=.15)

    def test_measured_room_noise_does_not_become_missing_singing(self):
        random = np.random.default_rng(721)
        sender = self.sender + random.normal(0, .003, len(self.sender))
        n = np.arange(96 * self.rate)
        remote = np.interp(n + 2 * self.rate - self.delay * self.rate,
                           np.arange(len(sender)), sender, left=0, right=0)
        # Network loss during one voiced event and one natural noisy pause.
        for begin, end in ((45.2, 45.6), (52, 52.32)):
            remote[int((begin - 2) * self.rate):int((end - 2) * self.rate)] = 0
        master = self.backing[2 * self.rate:98 * self.rate] + remote
        result = analysis.analyze_arrays(master, self.backing, sender, self.rate,
                                        sender_noise_seconds=(45.4, 45.95))
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["dropouts"]["count"], 1)
        self.assertGreater(result["dropouts"]["senderNoiseFloorDb"], -65)

    def test_packet_grid_shifts_are_voice_presence_not_dropouts(self):
        n = np.arange(96 * self.rate)
        phase = np.where((n // int(.25 * self.rate)) % 2, .00175, -.00175)
        remote = np.interp(n + 2 * self.rate - self.delay * self.rate + phase * self.rate,
                           np.arange(len(self.sender)), self.sender, left=0, right=0)
        master = self.backing[2 * self.rate:98 * self.rate] + remote
        result = self.analyze(master)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["dropouts"]["count"], 0)
        self.assertAlmostEqual(abs(result["dropouts"]["normalRemoteGain"]), 1.0, delta=.15)

    def test_exact_rendered_backing_survives_runtime_phase_changes(self):
        n = np.arange(96 * self.rate)
        phase = np.sin(n / self.rate * .7) * 4
        rendered = np.interp(n + 2 * self.rate + phase, np.arange(len(self.backing)), self.backing)
        remote = np.interp(n + 2 * self.rate - self.delay * self.rate,
                           np.arange(len(self.sender)), self.sender, left=0, right=0) * .1
        master = rendered + remote
        result = analysis.analyze_arrays(master, self.backing, self.sender, self.rate,
                                        rendered_backing=rendered)
        self.assertEqual(result["status"], "PASS")
        self.assertTrue(all(window["micAbsNcc"] > .95 for window in result["windows"].values()))

    def test_unrelated_residual_is_unidentified_not_proven_missing_voice(self):
        rng = np.random.default_rng(113)
        expected = self.sender[10 * self.rate:14 * self.rate]
        unrelated = rng.normal(0, .1, len(expected))
        result = analysis.missing_intervals(unrelated, expected, self.rate, 10, 1.0, -100)
        self.assertEqual(result["count"], 0)
        self.assertEqual(result["status"], "INDETERMINATE")
        self.assertGreater(result["unidentifiedTotalMs"], 100)

    def test_native_non_grid_missing_boundaries_and_natural_pauses(self):
        rate = 48000
        rng = np.random.default_rng(312)
        voice = rng.normal(0, .03, 3 * rate)
        active = np.ones(len(voice), dtype=bool)
        active[2 * rate:int(2.5 * rate)] = False
        for milliseconds in (60, 100, 220):
            with self.subTest(milliseconds=milliseconds):
                received = voice.copy()
                start = int(.537 * rate)  # Deliberately off the old 20ms grid.
                stop = start + int(milliseconds * rate / 1000)
                received[start:stop] = np.where(np.arange(stop - start) % 2, 1, -1) / 32768
                received[2 * rate:int(2.5 * rate)] = 0  # Sender's natural pause.
                result = analysis.native_missing_intervals(received, active, rate, 0)
                self.assertEqual(result["count"], 1)
                self.assertAlmostEqual(result["totalMissingMs"], milliseconds, delta=.1)
                self.assertAlmostEqual(result["intervals"][0]["songSeconds"], .537, delta=.0001)

    def test_partial_digital_overlap_does_not_hide_unresolved_missing_component(self):
        expected = self.sender[10 * self.rate:14 * self.rate].copy()
        received = expected.copy()
        received[self.rate:round(1.22 * self.rate)] = 0
        native = expected.copy()
        native[round(1.08 * self.rate):round(1.14 * self.rate)] = 0
        result = analysis.missing_intervals(received, expected, self.rate, 0, 1, -100,
                                           native_received=native, native_rate=self.rate)
        self.assertEqual(result["status"], "INDETERMINATE")
        self.assertEqual(result["count"], 1)
        self.assertGreater(len(result["componentOnlyUnresolvedIntervals"]), 0)

    def test_native_short_gaps_are_reported_beside_60ms_candidate_events(self):
        rate = 48000
        rng = np.random.default_rng(717)
        residual = rng.normal(0, .03, 2 * rate)
        for begin, milliseconds in ((.123, 5), (.537, 60), (1.6, 20)):
            start = round(begin * rate)
            residual[start:start + round(milliseconds * rate / 1000)] = 0
        result = analysis.native_missing_intervals(residual, np.ones(len(residual), dtype=bool), rate, 0)
        self.assertEqual(result["count"], 1)  # Original >=60ms audible-candidate rule.
        self.assertEqual(result["packetScaleSilence"]["count"], 3)
        self.assertAlmostEqual(result["packetScaleSilence"]["totalMs"], 85, delta=.1)

    def test_native_clock_activity_is_not_replaced_by_coarser_projection_grid(self):
        expected = self.sender[10 * self.rate:14 * self.rate].copy()
        received = expected.copy()
        received[self.rate:round(1.06 * self.rate)] = 0
        coarse = np.ones(200, dtype=bool)
        coarse[51] = False
        result = analysis.missing_intervals(received, expected, self.rate, 0, 1, -100,
                                           native_received=received, native_rate=self.rate,
                                           source_active_frames=coarse,
                                           native_source_active=np.ones(len(received), dtype=bool))
        self.assertEqual(result["count"], 1)
        self.assertAlmostEqual(result["totalMissingMs"], 60, delta=.2)

    def test_nonzero_attenuated_voice_is_not_hidden_by_digital_zero_detector(self):
        expected = self.sender[10 * self.rate:14 * self.rate].copy()
        for milliseconds in (60, 100):
            with self.subTest(milliseconds=milliseconds):
                received = expected.copy()
                received[self.rate:self.rate + round(milliseconds / 1000 * self.rate)] *= .01
                result = analysis.missing_intervals(received, expected, self.rate, 0, 1, -100,
                                                   native_received=received, native_rate=self.rate)
                self.assertEqual(result["status"], "MEASURED")
                self.assertEqual(result["count"], 1)
                self.assertAlmostEqual(result["totalMissingMs"], milliseconds, delta=20)

    def test_diagnostic_subwindow_summary_preserves_failed_primary_gate(self):
        spec = importlib.util.spec_from_file_location("diagnostic", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        diagnostic = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(diagnostic)
        rows = [{"voiceActiveMs": 100, "accepted": True, "micToRemoteMs": 80, "micNcc": .9,
                 "effectiveVoiceToBackingMs": 78},
                {"voiceActiveMs": 200, "accepted": False, "micNcc": .1},
                {"voiceActiveMs": 0, "accepted": True, "micToRemoteMs": 0, "micNcc": .8}]
        result = diagnostic.summarize(rows)
        self.assertEqual(result["scope"], "DIAGNOSTIC_ONLY")
        self.assertEqual(result["voicedMs"], 300)
        self.assertEqual(result["acceptedVoicedMs"], 100)
        self.assertAlmostEqual(result["acceptedVoicedFraction"], 1 / 3)
        self.assertEqual(result["physicalLagMs"]["median"], 80)
        self.assertEqual(result["effectiveVoiceToBackingMs"]["median"], 78)

    def test_longer_context_resolves_alias_without_lowering_ncc_gate(self):
        spec = importlib.util.spec_from_file_location("segmented", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        sender = self.sender.copy()
        sender[4 * self.rate:5 * self.rate] = (.35 * sender[5 * self.rate:6 * self.rate] +
                                               np.sqrt(1 - .35 ** 2) * sender[4 * self.rate:5 * self.rate])
        received = sender[2 * self.rate:98 * self.rate]
        match = segmented.match_with_context(received, sender, 3 * self.rate, self.rate,
                                              4.9 * self.rate, 0, len(received), self.rate)
        self.assertTrue(match["accepted"])
        self.assertGreater(match["contextSeconds"], 1)
        self.assertGreater(match["ncc"], .95)
        self.assertLess(abs(match["position"] - 5 * self.rate), .1)
        repeated = np.tile(sender[:self.rate // 4], 400)
        impossible = segmented.match_with_context(repeated, repeated, 3 * self.rate, self.rate,
                                                   3 * self.rate, 0, len(repeated), self.rate)
        self.assertFalse(impossible["accepted"])

    def test_approved_segment_gate_keeps_unidentified_voice_unmeasured(self):
        spec = importlib.util.spec_from_file_location("segmented_gate", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        windows = {name: {"acceptedVoicedFraction": 1, "physicalLagMs": {"median": lag}}
                   for name, lag in (("start", 80), ("middle", 81), ("end", 80.5))}
        result = segmented.primary_report(windows)
        self.assertEqual(result["confidenceStatus"], "PASS")
        self.assertAlmostEqual(result["drift"]["endMinusStartMs"], .5)
        windows["end"]["acceptedVoicedFraction"] = .9
        result = segmented.primary_report(windows)
        self.assertEqual(result["confidenceStatus"], "FAIL")
        self.assertIsNone(result["medianLagMs"])
        self.assertIsNone(result["drift"])

    def test_approved_segment_gate_rejects_missing_required_window_cells(self):
        spec = importlib.util.spec_from_file_location("segmented_coverage", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        rows = [{"voiceActiveMs": 1000, "accepted": True, "micToRemoteMs": 80, "micNcc": .9},
                {"voiceActiveMs": 0, "accepted": False, "status": "outside recording"}]
        partial = segmented.summarize(rows)
        result = segmented.primary_report({name: partial for name in ("start", "middle", "end")})
        self.assertEqual(result["confidenceStatus"], "FAIL")
        self.assertIsNone(result["drift"])

    def test_packet_clock_activity_mapping_does_not_clamp_to_quiet_peak_or_eof(self):
        spec = importlib.util.spec_from_file_location("segmented_activity", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        # The known packet clock selects real active source frame 4000; a
        # failed correlation peak at unrelated quiet frame 0 is not an input.
        positions, available = segmented.source_frames_from_clock(np.array([50, 150, 250]),
                                                                   np.array([100, 200]), np.array([0, 8000]))
        self.assertEqual(positions[1], 4000)
        self.assertTrue(available[1])
        self.assertTrue(np.isnan(positions[0]))
        self.assertTrue(np.isnan(positions[2]))
        self.assertFalse(available[0])
        self.assertFalse(available[2])

    def test_whole_song_nonzero_plc_cannot_be_reported_as_zero_loss_pass(self):
        spec = importlib.util.spec_from_file_location("segmented_presence", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        sender = self.sender[10 * self.rate:14 * self.rate].copy()
        received = sender.copy()
        received[self.rate:round(1.2 * self.rate)] = np.random.default_rng(77).normal(0, .1, round(.2 * self.rate))
        result = segmented.match_song_presence(received, sender, np.arange(4) * self.rate,
                                               np.ones(200, dtype=bool), self.rate, -100,
                                               received, self.rate, 0)
        self.assertEqual(result["status"], "INDETERMINATE")
        self.assertGreater(result["unidentifiedTotalMs"], 0)

    def test_clock_anchored_periodic_presence_keeps_real_60ms_hole(self):
        spec = importlib.util.spec_from_file_location("segmented_periodic", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        # Repeated voiced material is ambiguous over a 1.25s timing search,
        # but the independently recorded packet clock identifies this cycle.
        sender = np.tile(self.sender[:self.rate // 4], 16)
        received = sender.copy()
        for missing_ms in (0, 60):
            with self.subTest(missing_ms=missing_ms):
                received[:] = sender
                received[self.rate:self.rate + round(missing_ms / 1000 * self.rate)] = 0
                result = segmented.match_song_presence(received, sender, np.arange(4) * self.rate,
                    np.ones(200, dtype=bool), self.rate, -100, received, self.rate, 0)
                self.assertEqual(result["status"], "MEASURED")
                self.assertTrue(any(not row["accepted"] for row in result["wholeSongIdentity"]["subwindows"]))
                self.assertEqual(result["count"], int(missing_ms > 0))
                self.assertAlmostEqual(result["totalMissingMs"], missing_ms, delta=.2)

    def test_unique_replayed_old_voice_does_not_prove_current_packet_presence(self):
        spec = importlib.util.spec_from_file_location("segmented_replayed", Path(__file__).with_name("diagnose_real_mic_windows.py"))
        segmented = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(segmented)
        sender = self.sender[10 * self.rate:15 * self.rate].copy()
        received = sender[:4 * self.rate].copy()
        # Waveform matching finds an exact, unique previous source segment,
        # but the independent packet stamp requires current input 250ms later.
        result = segmented.match_song_presence(received, sender, (np.arange(4) + .25) * self.rate,
            np.ones(200, dtype=bool), self.rate, -100, received, self.rate, 0)
        self.assertEqual(result["status"], "INDETERMINATE")
        self.assertGreater(result["unidentifiedTotalMs"], 0)

    def test_louder_appended_song_cannot_replace_original_backing_origin(self):
        original = np.r_[self.make_master(), self.backing[98 * self.rate:]]
        master = np.r_[original, 5 * self.backing[:20 * self.rate]]
        timeline = [{"wavFrame": 0, "wavFrames": len(master), "valid": True,
                     "presentationRoomFrame": self.anchor + 2 * 48000,
                     "endPresentationRoomFrame": self.anchor + 120 * 48000}]
        result = analysis.analyze_arrays(master, self.backing, self.sender, self.rate,
            receiver_timeline=timeline, receiver_native_rate=self.rate,
            song_start_room_frame=self.anchor)
        self.assertAlmostEqual(result["fileStartsAtSongSeconds"], 2, delta=.001)

    def test_fractional_and_independent_file_origins_use_room_anchor(self):
        room_rate = 48000
        timeline = [{"wavFrame": 0, "physicalRoomFrame": self.anchor + 3 * room_rate},
                    {"wavFrame": 48000, "physicalRoomFrame": self.anchor + 4 * room_rate}]
        self.assertAlmostEqual(analysis.timeline_position(timeline, 24000, "physicalRoomFrame"), self.anchor + 3.5 * room_rate)
        self.assertAlmostEqual(analysis.sender_song_origin(timeline, self.anchor, room_rate), 3.0)

    def test_duplicate_nonlocal_peaks_report_ambiguity(self):
        signal = np.tile(self.sender[:8000], 5)
        match = analysis.locate(signal[:4000], signal, 0, 16000, 8000)
        self.assertGreater(match["ncc"], .99)
        self.assertGreater(match["secondPeakNcc"], .99)
        self.assertFalse(match["uniquePeak"])

    def fractional_lag_fixture(self):
        rng = np.random.default_rng(1045)
        count = 4 * self.rate
        frequencies = np.fft.rfftfreq(count, 1 / self.rate)
        band = (frequencies >= 300) & (frequencies <= 3400)
        spectrum = np.fft.rfft(rng.normal(size=count)) * band
        reference = np.fft.irfft(spectrum, count)
        shifted = np.fft.irfft(spectrum * np.exp(2j * np.pi * frequencies / self.rate * .5), count)[self.rate:2 * self.rate]
        unrelated = np.fft.irfft(np.fft.rfft(rng.normal(size=count)) * band, count)[self.rate:2 * self.rate]
        segment = .26 * shifted / shifted.std() + np.sqrt(1 - .26 ** 2) * unrelated / unrelated.std()
        return reference, segment

    def test_fractional_lag_peak_does_not_fail_unchanged_ncc_gate_on_integer_grid(self):
        reference, segment = self.fractional_lag_fixture()
        match = analysis.locate(segment, reference, self.rate - 1000, self.rate + 1000, self.rate)
        self.assertGreater(match["ncc"], .24)
        self.assertLess(abs(match["position"] - (self.rate + .5)), .1)
        self.assertTrue(match["uniquePeak"])

    def test_fractional_lag_competitor_is_refined_before_uniqueness_gate(self):
        reference, segment = self.fractional_lag_fixture()
        match = analysis.locate(segment, np.tile(reference, 2), self.rate - 1000, 5 * self.rate + 1000, self.rate)
        self.assertGreater(match["secondPeakNcc"], .24)
        self.assertFalse(match["uniquePeak"])

    def test_equal_repeated_candidates_cannot_pass_identification(self):
        sender = np.tile(self.sender[:self.rate // 4], 400)
        n = np.arange(96 * self.rate)
        remote = np.interp(n + 2 * self.rate - self.delay * self.rate,
                           np.arange(len(sender)), sender, left=0, right=0)
        master = self.backing[2 * self.rate:98 * self.rate] + remote
        result = analysis.analyze_arrays(master, self.backing, sender, self.rate)
        self.assertEqual(result["status"], "FAIL")
        self.assertIsNone(result["medianLagMs"])
        self.assertIsNone(result["drift"])

    def test_exact_packet_and_render_csv_maps_piecewise_capture_spans(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mic.timeline.csv"
            path.write_text("wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz\n"
                            "0,12000,120,48000,1,12120,12242,48000\n"
                            "120,12120,120,48000,1,12242,12362,48000\n", encoding="utf-8")
            timeline, quality = analysis.read_timeline(path, "sender", 240, 48000)
            self.assertEqual(quality["rows"], 2)
            self.assertAlmostEqual(analysis.timeline_position(timeline, 60, "physicalRoomFrame"), 12181)
            self.assertAlmostEqual(analysis.timeline_position(timeline, 180, "physicalRoomFrame"), 12302)
            self.assertAlmostEqual(analysis.timeline_position(timeline, 60, "effectiveRoomFrame"), 12060)
            path.write_text(path.read_text().replace("120,12120,120", "121,12120,120"), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "gap"):
                analysis.read_timeline(path, "sender", 240, 48000)

    def test_invalid_physical_span_is_flagged_without_repairing_the_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mic.timeline.csv"
            path.write_text("wavOffsetFrames,timelineFrame,frames,sampleRateHz,roomClockValid,captureTimelineFrame,captureEndTimelineFrame,timelineSampleRateHz\n"
                            "0,12000,120,48000,1,12120,12000,48000\n"
                            "120,12120,120,48000,1,12242,12362,48000\n", encoding="utf-8")
            original = path.read_bytes()
            timeline, quality = analysis.read_timeline(path, "sender", 240, 48000)
            self.assertEqual(quality["invalidPhysicalSpanRows"], 1)
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaisesRegex(ValueError, "valid physical clock"):
                analysis.timeline_position(timeline, 60, "physicalRoomFrame")
            self.assertEqual(analysis.timeline_position(timeline, 180, "physicalRoomFrame"), 12302)


if __name__ == "__main__":
    unittest.main()
