import threading

import numpy as np
import soundfile as sf

from backend.recordings import studio_profiles as profiles
from backend.recordings.studio_audio import _profile


def test_multiband_blocks_use_shared_executor_without_changing_reductions(tmp_path, monkeypatch):
    path = tmp_path / "source.wav"
    sf.write(
        path, np.random.default_rng(42).normal(0, 0.2, (8000 * 11 + 31, 2)), 8000, subtype="DOUBLE"
    )
    cancel = threading.Event()
    requests = (profiles.ProfileRequest(), profiles.ProfileRequest(True, (200, 3000)))
    expected = (
        _profile(path, cancel),
        _profile(path, cancel, center=True, voice_band=True, band_hz=(200, 3000)),
    )
    blocks = []

    def execute(function, values):
        for block in values:
            blocks.append(len(block))
            yield function(block)

    monkeypatch.setattr(profiles, "ordered_map", execute, raising=False)
    actual = profiles.measure_profiles(path, cancel, requests)
    for result, reference in zip(actual, expected):
        np.testing.assert_array_equal(result, reference)
    assert len(blocks) == 4
