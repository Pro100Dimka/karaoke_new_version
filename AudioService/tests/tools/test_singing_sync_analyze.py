import importlib.util
import unittest
from pathlib import Path

import numpy as np


MODULE = Path(__file__).parents[2] / "tools" / "singing-sync-analyze.py"
spec = importlib.util.spec_from_file_location("singing_sync_analyze", MODULE)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Cannot load {MODULE}")
analysis = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analysis)


class SingingSyncAnalysisTests(unittest.TestCase):
    def test_long_backing_normalization_cannot_exceed_one_or_select_a_false_song_position(self):
        rate = 48_000
        rng = np.random.default_rng(18)
        backing = rng.normal(size=rate * 60).astype(np.float32)
        backing[:rate * 50] *= 0.2
        backing[rate * 50:] *= 0.0001
        master = backing[rate * 52:rate * 57].copy()
        offset, confidence = analysis.backing_offset(master, backing, rate)
        self.assertLess(abs(offset - 52), 0.001)
        self.assertLessEqual(confidence, 1.001)

    def test_measures_both_vocals_against_the_backing_in_final_mix(self):
        rate = 48_000
        rng = np.random.default_rng(27)
        backing = np.convolve(rng.normal(size=rate * 6),
                              np.ones(40) / 40, mode="same").astype(np.float32) * 0.2
        mix = np.zeros(rate * 8, dtype=np.float32)
        music_offset = int(0.8 * rate)
        mix[music_offset:music_offset + backing.size] += backing
        for beat in range(1, 11):
            for frequency, skew_ms in ((697.0, 12), (941.0, 84)):
                marker = analysis.pilot_template(rate, frequency)
                start = music_offset + beat * rate // 2 + skew_ms * rate // 1000
                mix[start:start + marker.size] += marker * 0.12

        result = analysis.analyze_mix(mix, backing, rate, own_frequency=697.0,
                                      remote_frequency=941.0)
        self.assertLess(abs(result["backingOffsetMs"] + 800), 1)
        self.assertLess(abs(result["own"]["p50Ms"] - 12), 2)
        self.assertLess(abs(result["remote"]["p50Ms"] - 84), 2)
        self.assertLess(abs(result["vocalToVocal"]["p50Ms"] - 72), 2)
        self.assertGreaterEqual(result["remote"]["detected"], 9)

    def test_does_not_treat_a_missing_remote_vocal_as_zero_skew(self):
        rate = 48_000
        rng = np.random.default_rng(21)
        backing = np.convolve(rng.normal(size=rate * 4),
                              np.ones(40) / 40, mode="same").astype(np.float32) * 0.2
        mix = np.zeros(rate * 5, dtype=np.float32)
        mix[rate // 2:rate // 2 + backing.size] = backing
        result = analysis.analyze_mix(mix, backing, rate, own_frequency=697.0,
                                      remote_frequency=941.0)
        self.assertEqual(result["remote"]["detected"], 0)
        self.assertIsNone(result["remote"]["p50Ms"])

    def test_unrelated_sustained_tone_is_not_a_vocal_pilot(self):
        rate = 48_000
        rng = np.random.default_rng(33)
        backing = rng.normal(size=rate * 5).astype(np.float32) * 0.03
        mix = np.zeros(rate * 6, dtype=np.float32)
        mix[rate // 2:rate // 2 + backing.size] = backing
        frames = np.arange(mix.size)
        mix += (0.03 * np.sin(2 * np.pi * 697.0 * frames / rate)).astype(np.float32)

        result = analysis.analyze_mix(mix, backing, rate, own_frequency=697.0,
                                      remote_frequency=941.0)
        self.assertEqual(result["own"]["detected"], 0)

    def test_expected_markers_cover_only_the_recorded_song_interval(self):
        rate = 48_000
        backing = np.random.default_rng(41).normal(size=rate * 6).astype(np.float32) * 0.1
        excerpt = backing[rate * 3:rate * 5].copy()
        result = analysis.analyze_mix(excerpt, backing, rate, 697.0, 941.0)
        self.assertEqual(result["own"]["expected"], 3)
        self.assertEqual(result["remote"]["expected"], 3)

    def test_detects_repeated_pilots_under_unrelated_audio(self):
        rate = 48_000
        rng = np.random.default_rng(52)
        backing = rng.normal(size=rate * 7).astype(np.float32) * 0.1
        mix = np.zeros(rate * 8, dtype=np.float32)
        mix[rate // 2:rate // 2 + backing.size] = backing
        mix += rng.normal(size=mix.size).astype(np.float32) * 0.015
        for beat in range(1, 13):
            for frequency, skew_ms in ((697.0, 12), (941.0, 68)):
                marker = analysis.pilot_template(rate, frequency)
                start = rate // 2 + beat * rate // 2 + skew_ms * rate // 1000
                mix[start:start + marker.size] += marker * 0.07

        result = analysis.analyze_mix(mix, backing, rate, 697.0, 941.0)
        self.assertGreaterEqual(result["own"]["detected"], 10)
        self.assertGreaterEqual(result["remote"]["detected"], 10)
        self.assertLess(abs(result["remote"]["p50Ms"] - 68), 2)

    def test_one_transient_cannot_produce_a_skew_distribution(self):
        rate = 48_000
        backing = np.random.default_rng(68).normal(size=rate * 6).astype(np.float32) * 0.1
        mix = np.zeros(rate * 7, dtype=np.float32)
        mix[rate // 2:rate // 2 + backing.size] = backing
        marker = analysis.pilot_template(rate, 697.0)
        start = rate // 2 + rate // 2 + rate // 100
        mix[start:start + marker.size] += marker * 0.12
        result = analysis.analyze_mix(mix, backing, rate, 697.0, 941.0)
        self.assertEqual(result["own"]["detected"], 1)
        self.assertIsNone(result["own"]["p50Ms"])


if __name__ == "__main__":
    unittest.main()
