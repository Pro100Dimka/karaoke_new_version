from __future__ import annotations

import math
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings.studio_audio import _profile


@pytest.mark.parametrize("subtype", ["PCM_16", "PCM_24", "FLOAT", "DOUBLE"])
def test_profile_keeps_original_double_precision_rms(tmp_path, subtype):
    rate = 8000
    samples = np.random.default_rng(42).normal(0, 0.1, size=(rate, 2))
    path = tmp_path / "recording.wav"
    sf.write(path, samples, rate, subtype=subtype)
    with sf.SoundFile(path) as source:
        actual = source.read(dtype="float64", always_2d=True)
    expected = np.array(
        [
            10 * math.log10(max(1e-12, float(np.mean(block * block))))
            for block in np.split(actual, 10)
        ]
    )
    np.testing.assert_allclose(_profile(path, threading.Event()), expected, atol=1e-5, rtol=0)


def test_profile_raises_on_cancelled_audio(tmp_path):
    path = tmp_path / "recording.wav"
    sf.write(path, np.zeros(8000), 8000)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancelled"):
        _profile(path, cancel)


def test_profile_does_not_mask_invalid_audio(tmp_path):
    path = tmp_path / "recording.wav"
    sf.write(path, np.array([0.0, np.nan, 0.1], dtype=np.float32), 8000, subtype="FLOAT")
    with pytest.raises(Exception, match="invalid samples"):
        _profile(path, threading.Event())
