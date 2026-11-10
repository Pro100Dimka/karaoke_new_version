"""Regression: wide spatial vocals without discrete taps preserve the dry vocal without temporal evidence."""

from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.recordings.studio_space import apply_reference_space, analyze_space


def test_width_without_temporal_evidence_preserves_voice(tmp_path: Path):
    rng = np.random.default_rng(73)
    rate = 8000
    samples = rng.standard_normal((rate * 8, 1)).astype("float32") * 0.04
    recorded = np.repeat(samples, 2, axis=1)
    # A decorrelated wide production, not a periodic/identifiable echo tap.
    noise = rng.standard_normal(recorded.shape).astype("float32") * 0.02
    reference = recorded + noise
    dry, ref, output = [tmp_path / n for n in ("dry.wav", "reference.wav", "result.wav")]
    sf.write(dry, recorded, rate, subtype="FLOAT")
    sf.write(ref, reference, rate, subtype="FLOAT")
    profile = analyze_space(ref, threading.Event())
    assert profile.delay_gain == 0
    report = apply_reference_space(object(), ref, dry, dry, output, threading.Event())
    assert report["status"] == "no-supported-addition"
    assert report["applied"]["delay_gain"] == 0
    assert report["applied"]["reverb_gain"] == 0
    rendered, _ = sf.read(output, always_2d=True)
    np.testing.assert_allclose(rendered, recorded, atol=1e-8)
