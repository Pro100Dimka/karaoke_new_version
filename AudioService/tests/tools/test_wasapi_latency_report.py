import importlib.util
from pathlib import Path
import unittest


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
        self.assertIn("PERIOD_MINIMUM_HIGH", causes)
        self.assertIn("CAPTURE_LATENCY_HIGH", causes)
        self.assertIn("OUTPUT_LATENCY_HIGH", causes)
        self.assertIn("DRIVER_OR_WINDOWS_LIMITED", causes)
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


if __name__ == "__main__":
    unittest.main()
