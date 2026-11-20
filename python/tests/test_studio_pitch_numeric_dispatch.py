"""Numeric fallback follows the current Librosa dynamic-ufunc dispatch history."""

import json
from pathlib import Path
import subprocess
import sys
import textwrap

import pytest


@pytest.mark.parametrize("order", [("float64", "float32"), ("float32", "float64")])
def test_numeric_helpers_preserve_both_runtime_dispatch_orders(order):
    script = textwrap.dedent("""
        import json, sys
        import librosa
        import numpy as np
        from librosa.core import pitch
        from librosa.util import utils
        from backend.recordings.studio_pitch_numeric import autocorrelation, parabolic_interpolation
        from backend.recordings.studio_pitch_difference import bounded_difference

        def equal(actual, expected):
            return actual.shape == expected.shape and actual.dtype == expected.dtype and actual.tobytes() == expected.tobytes()

        def types():
            return {"interpolation": list(pitch._pi_wrapper.types), "power": list(utils._cabs2.types)}

        before, rows = types(), []
        for name in json.loads(sys.argv[1]):
            dtype = np.dtype(name)
            random = np.random.default_rng(491)
            values = random.uniform(-1.2, 1.2, (311, 41)).astype(dtype)
            samples = random.normal(0, .1, 1024 + 160 * 173).astype(dtype)
            frames = librosa.util.frame(samples, frame_length=1024, hop_length=160)
            expected_interpolation = pitch._parabolic_interpolation(values)
            actual_interpolation = parabolic_interpolation(values)
            expected_correlation = pitch.audio.autocorrelate(frames, max_size=321, axis=-2)
            actual_correlation = autocorrelation(frames, 321)
            reference = pitch._cumulative_mean_normalized_difference
            expected_difference = reference(frames, 10, 320)
            actual_difference = bounded_difference(frames, 10, 320, reference=reference)
            rows.append({
                "dtype": name,
                "interpolationExact": equal(actual_interpolation, expected_interpolation),
                "correlationExact": equal(actual_correlation, expected_correlation),
                "differenceExact": equal(actual_difference, expected_difference),
                "compiledTypes": types(),
            })
        print(json.dumps({"before": before, "rows": rows}))
    """)
    completed = subprocess.run(
        [sys.executable, "-c", script, json.dumps(order)],
        cwd=Path(__file__).parents[1],
        text=True,
        capture_output=True,
        timeout=45,
        check=True,
    )
    report = json.loads(completed.stdout)
    assert report["before"] == {"interpolation": [], "power": []}
    assert all(
        row[key]
        for row in report["rows"]
        for key in ("interpolationExact", "correlationExact", "differenceExact")
    ), report
