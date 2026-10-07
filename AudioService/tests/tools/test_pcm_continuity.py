import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

MODULE = Path(__file__).parents[2] / "tools" / "pcm-continuity.py"
spec = importlib.util.spec_from_file_location("pcm_continuity", MODULE)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Cannot load {MODULE}")
continuity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(continuity)


class PcmContinuityTests(unittest.TestCase):
    def setUp(self):
        self.gain = 0.125
        self.source = continuity.encode_frames(np.arange(1000, dtype=np.uint32)) * self.gain

    def test_continuous_pcm_has_no_false_positive(self):
        result = continuity.analyze_samples(self.source, 1000, self.gain)
        self.assertEqual(result["missing_frames"], 0)
        self.assertEqual(result["duplicate_frames"], 0)
        self.assertEqual(result["zero_gap_frames"], 0)
        self.assertEqual(result["continuity_percent"], 100.0)

    def test_missing_and_duplicated_frames_are_distinct(self):
        broken = np.concatenate((self.source[:300], self.source[304:600],
                                 self.source[590:600], self.source[600:]))
        result = continuity.analyze_samples(broken, 1000, self.gain)
        self.assertGreaterEqual(result["missing_frames"], 4)
        self.assertGreaterEqual(result["duplicate_frames"], 10)
        self.assertGreaterEqual(result["repeated_sequences"], 1)

    def test_zero_gap_cannot_pass_as_continuous(self):
        broken = self.source.copy()
        broken[400:448] = 0
        result = continuity.analyze_samples(broken, 1000, self.gain)
        self.assertEqual(result["longest_zero_gap_frames"], 48)
        self.assertLess(result["continuity_percent"], 100.0)
        self.assertGreaterEqual(result["missing_frames"], 48)

    def test_starvation_window_is_correlated_with_real_pcm_gap(self):
        broken = self.source.copy()
        broken[400:448] = 0
        events = [{"capturedFrames": 420, "shortfallFrames": 14},
                  {"capturedFrames": 800, "shortfallFrames": 1}]
        result = continuity.analyze_samples(broken, 1000, self.gain, events,
                                            correlation_window_frames=64)
        self.assertEqual(result["starvation_windows_with_pcm_gap"], 1)
        self.assertEqual(result["starvation_windows_without_pcm_gap"], 1)

    def test_queue_escalation_is_correlated_with_pcm_gap(self):
        broken = self.source.copy()
        broken[400:448] = 0
        changes = [{"capturedFrames": 420, "reason": "1"},
                   {"capturedFrames": 800, "reason": "2"}]
        result = continuity.analyze_samples(broken, 1000, self.gain,
                                            queue_events=changes,
                                            correlation_window_frames=64)
        self.assertEqual(result["queue_changes_with_pcm_gap"], 1)
        self.assertEqual(result["queue_changes_without_pcm_gap"], 1)

    def test_alignment_uses_both_channels_and_ignores_outer_silence(self):
        signal = continuity.encode_frames(np.arange(4000, dtype=np.uint32)) * self.gain
        capture = np.concatenate((np.zeros((64, 2), dtype=np.float32), signal,
                                  np.zeros((64, 2), dtype=np.float32)))
        gain, leading, offset = continuity.estimate_gain(capture, 4000)
        active, start = continuity.trim_to_signal(capture)
        self.assertAlmostEqual(gain, self.gain, places=5)
        self.assertEqual((leading, offset, start), (64, 0, 64))
        self.assertEqual(len(active), 4000)

    def test_cli_rejects_nonpositive_or_nonfinite_explicit_gain(self):
        command = [sys.executable, str(MODULE), "analyze", "missing", "--session", "1"]
        for gain in ("0", "-1", "nan", "inf"):
            with self.subTest(gain=gain):
                result = subprocess.run(
                    [*command, "--gain", gain],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn("--gain must be a finite positive number", result.stderr)

    def test_analysis_rejects_nonfinite_gain(self):
        for gain in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(gain=gain), self.assertRaises(ValueError):
                continuity.analyze_samples(self.source, 1000, gain)

    def test_capture_formats_decode_to_the_same_stereo_samples(self):
        cases = (
            ("Float32", "<f4", (0.5, -0.25)),
            ("Int16", "<i2", (16384, -8192)),
            ("Int32", "<i4", (1073741824, -536870912)),
        )
        with tempfile.TemporaryDirectory() as directory:
            for sample_format, dtype, samples in cases:
                with self.subTest(sample_format=sample_format):
                    path = Path(directory) / f"{sample_format}.pcm"
                    path.write_bytes(np.array(samples, dtype=dtype).tobytes())
                    actual = continuity.read_capture(
                        path,
                        {"channels": "2", "format": sample_format},
                    )
                    np.testing.assert_array_equal(actual, [[0.5, -0.25]])


if __name__ == "__main__":
    unittest.main()
