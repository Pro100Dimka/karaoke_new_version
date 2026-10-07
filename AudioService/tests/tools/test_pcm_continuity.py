import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import wave
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

    def test_reference_oracle_accepts_clean_gain_and_delay_without_false_alarms(self):
        rate = 48000
        frames = np.arange(rate, dtype=np.float64)
        reference = (0.25 * np.sin(2 * np.pi * 317 * frames / rate)
                     + 0.12 * np.sin(2 * np.pi * 733 * frames / rate)).astype(np.float32)
        observed = np.concatenate((np.zeros(137, dtype=np.float32), reference * 0.6))
        result = continuity.analyze_reference(reference, observed, rate)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["defects"], [])
        self.assertEqual(result["alignment_frames"], 137)

    def test_reference_oracle_aligns_device_startup_silence(self):
        rate = 48000
        frames = np.arange(rate, dtype=np.float64)
        reference = (0.3 * np.sin(2 * np.pi * (281 * frames / rate
                     + 23 * (frames / rate) ** 2))).astype(np.float32)
        observed = np.concatenate((np.zeros(19680, dtype=np.float32), reference))
        result = continuity.analyze_reference(reference, observed, rate)
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["alignment_frames"], 19680)

    def test_reference_oracle_locates_intentional_click_dropout_and_duplicate(self):
        rate = 48000
        frames = np.arange(rate, dtype=np.float64)
        reference = (0.3 * np.sin(2 * np.pi * (251 * frames / rate
                     + 31 * (frames / rate) ** 2))).astype(np.float32)
        cases = {
            "click": (15000, lambda signal: signal.__setitem__(15000, 0.95)),
            "dropout": (20000, lambda signal: signal.__setitem__(slice(20000, 20500), 0)),
            "duplicate": (25000, lambda signal: signal.__setitem__(
                slice(25000, 25400), signal[24600:25000])),
        }
        for kind, (position, mutate) in cases.items():
            with self.subTest(kind=kind):
                damaged = reference.copy()
                mutate(damaged)
                result = continuity.analyze_reference(reference, damaged, rate)
                self.assertEqual(result["status"], "FAIL")
                locations = [item["start_frame"] for item in result["defects"]
                             if item["kind"] == kind]
                self.assertTrue(any(abs(at - position) <= 512 for at in locations), result)

    def test_reference_oracle_reports_clipping_noise_distortion_and_drift(self):
        rate = 48000
        frames = np.arange(rate, dtype=np.float64)
        reference = (0.65 * np.sin(2 * np.pi * (197 * frames / rate
                     + 17 * (frames / rate) ** 2))).astype(np.float32)
        rng = np.random.default_rng(12345)
        cases = {
            "clipping": np.clip(reference * 2, -1, 1),
            "noise": reference + rng.normal(0, 0.025, len(reference)),
            "distortion": reference + 0.08 * reference ** 3,
            "timing_drift": reference[np.minimum(
                (np.arange(rate) * 1.003).astype(int), rate - 1)],
        }
        for kind, damaged in cases.items():
            with self.subTest(kind=kind):
                result = continuity.analyze_reference(reference, damaged, rate)
                self.assertEqual(result["status"], "FAIL", result)
                self.assertIn(kind, {item["kind"] for item in result["defects"]})

    def test_reference_oracle_is_inconclusive_for_short_or_silent_reference(self):
        silence = np.zeros(48000, dtype=np.float32)
        self.assertEqual(continuity.analyze_reference(silence, silence, 48000)["status"],
                         "INCONCLUSIVE")
        self.assertEqual(continuity.analyze_reference(silence[:100], silence[:100], 48000)
                         ["status"], "INCONCLUSIVE")

    def test_compare_command_saves_source_capture_report_and_defect_excerpt(self):
        rate = 48000
        frames = np.arange(rate, dtype=np.float64)
        source = (0.4 * np.sin(2 * np.pi * 313 * frames / rate)).astype(np.float32)
        captured = source.copy()
        captured[24000] = 0.99
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, samples in (("reference", source), ("capture", captured)):
                with wave.open(str(root / f"{name}.wav"), "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(rate)
                    output.writeframes((samples * 32767).astype("<i2").tobytes())
            output = root / "result"
            run = subprocess.run(
                [sys.executable, str(MODULE), "compare", str(root / "reference.wav"),
                 str(root / "capture.wav"), str(output)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(run.returncode, 1, run.stderr)
            report = json.loads((output / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "FAIL")
            self.assertTrue((output / "reference.wav").exists())
            self.assertTrue((output / "capture.wav").exists())
            self.assertTrue(list(output.glob("defect-*.wav")))

    def test_calibration_reports_false_positives_and_missed_defects(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "calibration.json"
            run = subprocess.run([sys.executable, str(MODULE), "calibrate", str(target)],
                                 capture_output=True, text=True, check=False)
            self.assertEqual(run.returncode, 0, run.stderr)
            report = json.loads(target.read_text(encoding="utf-8"))
            self.assertGreaterEqual(report["clean_cases"], 2)
            self.assertGreaterEqual(report["damaged_cases"], 5)
            self.assertEqual(report["false_positives"], 0)
            self.assertEqual(report["missed_defects"], 0)

    def test_defect_excerpt_uses_capture_position_after_alignment(self):
        rate = 48000
        frames = np.arange(rate, dtype=np.float64)
        reference = (0.3 * np.sin(2 * np.pi * (211 * frames / rate
                     + 19 * (frames / rate) ** 2))).astype(np.float32)
        captured = np.r_[np.zeros(19680, dtype=np.float32), reference]
        captured[19680 + 24000] = 0.99
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, samples in (("reference", reference), ("capture", captured)):
                with wave.open(str(root / f"{name}.wav"), "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(rate)
                    output.writeframes((samples * 32767).astype("<i2").tobytes())
            report = continuity.compare_wavs(root / "reference.wav", root / "capture.wav",
                                             root / "out")
            click = next(item for item in report["defects"] if item["kind"] == "click")
            with wave.open(str(root / "out" / click["excerpt"]), "rb") as excerpt:
                samples = np.frombuffer(excerpt.readframes(excerpt.getnframes()), dtype="<i2")
            self.assertGreater(samples.max(), 30000)


if __name__ == "__main__":
    unittest.main()
