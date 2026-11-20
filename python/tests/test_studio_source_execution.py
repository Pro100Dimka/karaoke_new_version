"""Independent source files share the render budget without changing PCM or mapping."""

from types import SimpleNamespace
import threading

import numpy as np
import pytest
import soundfile as sf

from backend.recordings import studio_parallel
from backend.recordings.studio_parallel import render_execution
from backend.recordings.studio_sources import IDENTITY_TIMELINE, _SourcePreparation


@pytest.fixture(autouse=True)
def available_workers(monkeypatch):
    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 8)


def _preparation(tmp_path, renderer):
    paths = tuple(tmp_path / f"{name}.wav" for name in ("voice", "backing", "ref", "orig", "mix"))
    prepare = _SourcePreparation(
        renderer, *paths, tmp_path, threading.Event(), IDENTITY_TIMELINE, True, None
    )
    prepare.info = SimpleNamespace(frames=100, samplerate=100, channels=6)
    prepare.channels = 6
    return prepare


def test_repeated_capture_checks_and_conversions_use_independent_workers(tmp_path):
    checks, writes = threading.Barrier(3), threading.Barrier(3)
    original = np.arange(600, dtype=np.float32).reshape(100, 6) / 1000

    def repeated(path, cancel):
        checks.wait(timeout=3)
        return True

    def convert(first, second, graph, output, cancel):
        writes.wait(timeout=3)
        samples, rate = sf.read(first, dtype="float32", always_2d=True)
        sf.write(output[-1], samples[:, :2], rate, subtype="FLOAT")

    renderer = SimpleNamespace(_repeated_output_channels=repeated, _mix=convert)
    preparation = _preparation(tmp_path, renderer)
    for path in (preparation.mix, preparation.vocal, preparation.recorded_backing):
        sf.write(path, original, 100, subtype="DOUBLE")
    with render_execution(preparation.cancel, workers=3):
        preparation._normalize_channels()
    assert preparation.channels == 2
    for path in (preparation.mix, preparation.vocal, preparation.recorded_backing):
        np.testing.assert_array_equal(sf.read(path, dtype="float32")[0], original[:, :2])


def test_reference_tracks_map_concurrently_before_offset_evidence(tmp_path, monkeypatch):
    barrier, completed = threading.Barrier(2), []

    def timeline(self, source, target):
        barrier.wait(timeout=3)
        completed.append(source)
        return 1.0

    def offset(*args):
        assert len(completed) == 2
        return 0, 0.95

    preparation = _preparation(tmp_path, SimpleNamespace(_reference_offset=offset))
    monkeypatch.setattr(_SourcePreparation, "_timeline", timeline)
    with render_execution(preparation.cancel, workers=2):
        preparation._map_reference()
    assert preparation.trusted and preparation.report["referenceCoverage"] == 1.0
