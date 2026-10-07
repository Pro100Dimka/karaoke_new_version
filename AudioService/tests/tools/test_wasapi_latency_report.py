import importlib.util
import json
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path

MODULE = Path(__file__).parents[2] / "tools" / "wasapi-latency-report.py"
spec = importlib.util.spec_from_file_location("wasapi_latency_report", MODULE)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class LatencyClassificationTests(unittest.TestCase):
    def test_large_minimum_with_one_period_queue_keeps_contributors_separate(self):
        causes = report.classify({
            "SharedEnginePeriodMinimumFrames": "480",
            "SharedEnginePeriodActualFrames": "480",
            "RuntimeOutputSampleRate": "48000",
            "RenderQueueFrames": "480",
            "LocalCaptureDeviceMs": "20",
            "LocalAudioServiceInternalMs": "1",
            "LocalResamplerDspMs": "0",
            "LocalRenderQueueMs": "10",
            "LocalEndpointOutputMs": "39",
            "SharedEnginePeriodFallback": "NONE",
            "RenderTimingPressureFrames": "0",
            "RenderConfirmedUnderrunFrames": "0",
        }, {}, {})
        for cause in (
            "PERIOD_MINIMUM_HIGH", "CAPTURE_LATENCY_HIGH", "OUTPUT_LATENCY_HIGH",
            "DRIVER_OR_WINDOWS_LIMITED",
        ):
            self.assertIn(cause, causes)
        self.assertNotIn("RENDER_QUEUE_HIGH", causes)

    def test_lock_queue_pressure_and_confirmed_underrun_are_independent(self):
        causes = report.classify({
            "SharedEnginePeriodMinimumFrames": "128",
            "SharedEnginePeriodActualFrames": "480",
            "RuntimeOutputSampleRate": "48000",
            "RenderQueueFrames": "960",
            "SharedEnginePeriodFallback": "ENGINE_PERIODICITY_LOCKED",
            "RenderTimingPressureFrames": "20",
            "RenderConfirmedUnderrunFrames": "3",
        }, {"SelectedPeriodFrames": "128", "RequestedPeriodFrames": "128",
            "RenderTimingPressureFrames": "0", "RenderConfirmedUnderrunFrames": "0"}, {})
        self.assertTrue({"PERIOD_LOCKED", "RENDER_QUEUE_HIGH", "TIMING_PRESSURE",
                         "CONFIRMED_UNDERRUN"}.issubset(causes))

    def test_format_fallback_and_unknown(self):
        self.assertIn("FORMAT_FALLBACK", report.classify({
            "RuntimeOutputSampleRate": "48000", "RequestedSampleRate": "44100",
        }, {}, {}))
        self.assertEqual(report.classify({}, {}, {}), ["UNKNOWN"])

    def test_portable_report_preserves_capture_period_selection(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            Path("run-endpoint.json").write_text(json.dumps({"capabilities": {}}))
            diagnostics = {"SelectedInputPeriodFrames": "128",
                           "RequestedInputPeriodFrames": "128",
                           "RuntimeInputPeriodFrames": "448",
                           "InputPeriodMismatchReason": "ENGINE_PERIODICITY_LOCKED",
                           "ClockBridgeTargetFrames": "45",
                           "ClockBridgeCapacityMs": "23.22",
                           "ClockBridgeFillBeforePullP95Frames": "301",
                           "ClockBridgeClockRelationship": "INDEPENDENT",
                           "ClockBridgeCorrectionRatio": "1.0002",
                           "DriftPpm": "40",
                           "ClockBridgeOverruns": "2",
                           "ClockBridgeUnderruns": "3",
                           "ClockBridgeDroppedFrames": "128",
                           "CapturePacketsPerWakeMax": "3",
                           "CaptureFramesPerWakeMax": "384",
                           "CapturePacketGapP99Us": "2900"}
            Path("run-samples.json").write_text(json.dumps([
                {"diagnostics": diagnostics}, {"diagnostics": diagnostics}]))
            Path("run-1-continuity.json").write_text(json.dumps({
                "continuity_percent": 100, "longest_pcm_gap_frames": 0,
                "duplicate_frames": 0}))
            report.make_report(Path("run"), 1)
            summary = json.loads(Path("run-summary.json").read_text())
            expected = {
                "capture": {
                    "selected_period_frames": 128,
                    "requested_period_frames": 128,
                    "period_frames": 448,
                    "mismatch_reason": "ENGINE_PERIODICITY_LOCKED",
                    "packets_per_wake_max": 3,
                    "frames_per_wake_max": 384,
                    "packet_gap_p99_us": 2900,
                },
                "clock_bridge": {
                    "target_frames": 45,
                    "capacity_ms": 23.22,
                    "fill_before_pull_p95_frames": 301,
                    "clock_relationship": "INDEPENDENT",
                    "drift_ppm": 40,
                    "fill_correction_ratio": 1.0002,
                    "overruns": 2,
                    "underruns": 3,
                    "dropped_frames": 128,
                },
            }
            for section, fields in expected.items():
                for field, value in fields.items():
                    self.assertEqual(summary[section][field], value, f"{section}.{field}")
            markdown = Path("run-REPORT.md").read_text()
            self.assertIn("target 45 frames", markdown)
            self.assertIn("capture bursts max 3 packets / 384 frames", markdown)

    def test_second_period_report_uses_only_its_own_samples(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            Path("run-endpoint.json").write_text(json.dumps({"capabilities": {}}))
            Path("run-samples.json").write_text(json.dumps([
                {"period": 160, "elapsedSeconds": 0, "diagnostics": {"SelectedPeriodFrames": "160", "RenderTimingPressureFrames": "5"}},
                {"period": 160, "elapsedSeconds": 30, "diagnostics": {"SelectedPeriodFrames": "160", "RenderTimingPressureFrames": "10"}},
                {"period": 480, "elapsedSeconds": 0, "diagnostics": {"SelectedPeriodFrames": "480", "RenderTimingPressureFrames": "100"}},
                {"period": 480, "elapsedSeconds": 30, "diagnostics": {"SelectedPeriodFrames": "480", "RenderTimingPressureFrames": "103"}},
            ]))
            Path("run-2-continuity.json").write_text(json.dumps({
                "continuity_percent": 100, "longest_pcm_gap_frames": 0,
                "duplicate_frames": 0}))
            report.make_report(Path("run"), 2)
            summary = json.loads(Path("run-2-summary.json").read_text())
            self.assertEqual(summary["selected_period_frames"], 480)
            self.assertEqual(summary["timing_pressure_delta_frames"], 3)

    def test_empty_session_reports_a_clear_error(self):
        with tempfile.TemporaryDirectory() as directory, chdir(directory):
            Path("run-endpoint.json").write_text(json.dumps({"capabilities": {}}))
            Path("run-samples.json").write_text("[]")
            Path("run-1-continuity.json").write_text("{}")

            with self.assertRaisesRegex(ValueError, "Session 1 has no samples"):
                report.make_report(Path("run"), 1)


if __name__ == "__main__":
    unittest.main()
