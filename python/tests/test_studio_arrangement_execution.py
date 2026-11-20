import threading

import numpy as np
import soundfile as sf

from backend.recordings import studio_arrangement as arrangement
from backend.recordings import studio_parallel
from backend.recordings.studio_parallel import render_execution


def test_structure_reads_independent_tracks_concurrently_with_identical_map(tmp_path, monkeypatch):
    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 8)
    paths = tmp_path / "backing.wav", tmp_path / "reference.wav"
    for index, path in enumerate(paths):
        samples = np.random.default_rng(index + 51).normal(0, 0.1, (8000 * 9 + 83, 2))
        sf.write(path, samples, 8000, subtype="FLOAT")
    cancel = threading.Event()
    expected = arrangement.analyze_arrangement(*paths, cancel).payload()
    barrier = threading.Barrier(2)
    original = arrangement._read_features

    def concurrent(*args, **kwargs):
        barrier.wait(timeout=3)
        return original(*args, **kwargs)

    monkeypatch.setattr(arrangement, "_read_features", concurrent)
    with render_execution(cancel, workers=2):
        actual = arrangement.analyze_arrangement(*paths, cancel)
    assert actual.payload() == expected
