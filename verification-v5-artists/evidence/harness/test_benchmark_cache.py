"""Harness-only guards; no production import, audio alignment or model inference."""
from hashlib import sha256
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from benchmark_cached_alignment import StrictCachedRecognition, canonical


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.waveform = object()
        self.source = {"shape": [16000], "dtype": "float32", "sha256": "sample-hash"}
        self.request = {"source": self.source, "language": "Ukrainian", "prompt": None,
                        "contexts": [[1.0, 2.0, "привіт світе"]]}
        self.result = {"contexts": [{"text": "привіт світе", "segments": []}]}
        self.digest = sha256(canonical(self.request)).hexdigest()
        self.records = {self.digest: {"request": self.request, "result": self.result}}
        self.cache = StrictCachedRecognition(self.records, [(self.waveform, self.source)])

    def test_known_context_returns_exact_cached_result_without_json_or_hash_work(self):
        with patch.object(json, "dumps", side_effect=AssertionError("JSON inside measured lookup")):
            with patch("benchmark_cached_alignment.sha256", side_effect=AssertionError("Hash inside measured lookup")):
                result = self.cache(self.waveform, "Ukrainian", None, [(1.0, 2.0, "привіт світе")])
        self.assertIs(result, self.result)
        self.cache.ensure_clean()
        self.assertEqual(self.cache.hits, 1)

    def test_new_context_is_a_hard_error(self):
        with self.assertRaisesRegex(RuntimeError, "Uncached ASR"):
            self.cache(self.waveform, "Ukrainian", None, [(1.0, 2.1, "привіт світе")])
        self.assertEqual(self.cache.hits, 0)

    def test_unknown_waveform_identity_is_not_assumed_equivalent(self):
        with self.assertRaisesRegex(RuntimeError, "Uncached ASR"):
            self.cache(object(), "Ukrainian", None, [(1.0, 2.0, "привіт світе")])

    def test_swallowed_miss_still_invalidates_a_later_successful_lookup(self):
        with self.assertRaises(RuntimeError):
            self.cache(self.waveform, "Russian", None, [(1.0, 2.0, "привіт світе")])
        self.cache(self.waveform, "Ukrainian", None, [(1.0, 2.0, "привіт світе")])
        with self.assertRaisesRegex(RuntimeError, "uncached ASR"):
            self.cache.ensure_clean()

    def test_corrupt_stored_request_key_is_rejected_before_timing(self):
        with self.assertRaisesRegex(ValueError, "Corrupt ASR"):
            StrictCachedRecognition({"0" * 64: self.records[self.digest]})

    def test_known_path_uses_verified_descriptor_without_reading_file(self):
        path = Path("/nonexistent/benchmark-input.wav")
        request = {"source": {"path": str(path), "sha256": "verified-audio-hash"},
                   "language": "Ukrainian", "prompt": None, "contexts": []}
        cache = StrictCachedRecognition({sha256(canonical(request)).hexdigest(): {
            "request": request, "result": {"segments": []}}}, path_sources=[(path, request["source"])])
        with patch.object(Path, "read_bytes", side_effect=AssertionError("File I/O inside lookup")):
            self.assertEqual(cache(path, "Ukrainian", None), {"segments": []})
        cache.ensure_clean()


if __name__ == "__main__":
    unittest.main()
