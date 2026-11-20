"""Reference pitch starts in the render budget and preserves exact source points."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.ai.domain import PitchPoint
from backend.domain_errors import DependencyError, DomainError


def _voice(path, rate=16000, frequency=220, seconds=2.1):
    time = np.arange(round(rate * seconds)) / rate
    phase = 2 * np.pi * frequency * time
    samples = 0.1 * np.sin(phase) + 0.025 * np.sin(phase * 2)
    sf.write(path, np.column_stack([samples, -samples]), rate, subtype="FLOAT")
    return path


def test_reference_chunks_start_before_results_are_requested(tmp_path, monkeypatch):
    from backend.recordings import studio_parallel, studio_pitch_analysis as analysis
    from backend.recordings.studio_pitch_prefetch import LocalPitchAnalyzer

    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 8)
    monkeypatch.setattr(analysis, "_CHUNK_SECONDS", 0.5)
    started, release, cancel = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def estimate(samples, current_cancel):
        started.set()
        assert release.wait(timeout=3)
        size = 1 + len(samples) // 160
        return np.full(size, 220.0), np.ones(size), np.ones(size, dtype=bool)

    monkeypatch.setattr(analysis, "_estimate", estimate)
    source = _voice(tmp_path / "reference.wav")
    analyzer = LocalPitchAnalyzer(cancel, lambda path: calls.append(path))
    with studio_parallel.render_execution(cancel, workers=2):
        try:
            analyzer.prefetch(source)
            assert started.wait(timeout=2), "Reference analysis did not start during preparation"
            assert not calls
            release.set()
            points = analyzer(source)
            assert [point.time for point in points] == [index / 100 for index in range(210)]
            assert not calls
        finally:
            release.set()
            analyzer.close()


@pytest.mark.parametrize("workers,count,initial", [(2, 40, 4), (7, 9, 9), (1, 40, 0)])
def test_reference_prefetch_fills_the_shared_bounded_queue(
    tmp_path, monkeypatch, workers, count, initial
):
    from backend.recordings import studio_parallel, studio_pitch_analysis as analysis

    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 9)
    consumed = []

    def offsets():
        for value in range(count):
            consumed.append(value)
            yield value

    def chunk(value):
        return [PitchPoint(value, 220.0, 1.0, True)]

    monkeypatch.setattr(analysis, "_pitch_work", lambda path, cancel: (chunk, offsets()))
    cancel = threading.Event()
    with studio_parallel.render_execution(cancel, workers=workers):
        pending = analysis.prefetch_pitch(tmp_path / "reference.wav", cancel)
        try:
            assert consumed == list(range(initial))
            assert [points[0].time for points in pending] == list(range(count))
        finally:
            pending.close()


@pytest.mark.parametrize("frequency", [65, 220])
def test_prefetched_points_are_exactly_the_standalone_analysis(tmp_path, monkeypatch, frequency):
    from backend.recordings import studio_parallel, studio_pitch_analysis as analysis
    from backend.recordings.studio_pitch_prefetch import LocalPitchAnalyzer

    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 8)
    monkeypatch.setattr(analysis, "_CHUNK_SECONDS", 1)
    source = _voice(tmp_path / "reference.wav", 44100, frequency, 3.011)
    cancel = threading.Event()
    expected = analysis.analyze_pitch(source, cancel)
    analyzer = LocalPitchAnalyzer(cancel, lambda path: analysis.analyze_pitch(path, cancel))
    with studio_parallel.render_execution(cancel, workers=2):
        try:
            analyzer.prefetch(source)
            assert analyzer(source) == expected
        finally:
            analyzer.close()


class ChunkResults:
    def __init__(self, action=None, error=None):
        self.points = (PitchPoint(time=0.0, frequency=220.0, confidence=0.99, audio_active=True),)
        self.remaining = iter([list(self.points)])
        self.action, self.error, self.closed = action, error, False

    def __iter__(self):
        return self

    def __next__(self):
        action, self.action = self.action, None
        if action is not None:
            action()
        if self.error is not None:
            raise self.error
        return next(self.remaining)

    def close(self):
        self.closed = True


def test_other_paths_use_fallback_without_consuming_prefetched_reference(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_prefetch as subject

    reference, voice = _voice(tmp_path / "reference.wav"), _voice(tmp_path / "voice.wav")
    chunks, scheduled, called = ChunkResults(), [], []

    def schedule(path, cancel):
        scheduled.append(path)
        return chunks

    def fallback(path):
        called.append(path)
        return ()

    monkeypatch.setattr(subject, "prefetch_pitch", schedule)
    analyzer = subject.LocalPitchAnalyzer(threading.Event(), fallback)
    analyzer.prefetch(reference)
    analyzer.prefetch(reference)
    assert analyzer(voice) == () and not chunks.closed
    assert analyzer(reference) == chunks.points and chunks.closed
    assert analyzer(reference) == ()
    assert scheduled == [reference] and called == [voice, reference]


@pytest.mark.parametrize("when", ["before", "during", "missing"])
def test_source_change_never_returns_stale_points(tmp_path, monkeypatch, when):
    from backend.recordings import studio_pitch_prefetch as subject

    source = _voice(tmp_path / "reference.wav")

    def change():
        with source.open("ab") as stream:
            stream.write(b"changed")

    chunks = ChunkResults(action=change if when == "during" else None)
    monkeypatch.setattr(subject, "prefetch_pitch", lambda path, cancel: chunks)
    called = []
    analyzer = subject.LocalPitchAnalyzer(threading.Event(), lambda path: called.append(path))
    analyzer.prefetch(source)
    if when == "before":
        change()
    if when == "missing":
        source.unlink()
    with pytest.raises(DependencyError, match="changed|unavailable"):
        analyzer(source)
    assert chunks.closed and not called


@pytest.mark.parametrize("when", ["before", "during"])
def test_cancellation_closes_pending_without_returning_points(tmp_path, monkeypatch, when):
    from backend.recordings import studio_pitch_prefetch as subject

    source, cancel = _voice(tmp_path / "reference.wav"), threading.Event()
    chunks = ChunkResults(action=cancel.set if when == "during" else None)
    monkeypatch.setattr(subject, "prefetch_pitch", lambda path, event: chunks)
    analyzer = subject.LocalPitchAnalyzer(cancel, lambda path: ())
    analyzer.prefetch(source)
    if when == "before":
        cancel.set()
    with pytest.raises(DomainError, match="cancel"):
        analyzer(source)
    assert chunks.closed


@pytest.mark.parametrize("fallback_fails", [False, True])
def test_analysis_failure_closes_all_owned_pending_work(tmp_path, monkeypatch, fallback_fails):
    from backend.recordings import studio_pitch_prefetch as subject

    source, other = _voice(tmp_path / "reference.wav"), _voice(tmp_path / "voice.wav")
    error = DependencyError("StudioMasterInvalidAudio", "Invalid analysis samples")
    chunks = ChunkResults(error=None if fallback_fails else error)
    monkeypatch.setattr(subject, "prefetch_pitch", lambda path, cancel: chunks)

    def fallback(path):
        raise error

    analyzer = subject.LocalPitchAnalyzer(threading.Event(), fallback)
    analyzer.prefetch(source)
    with pytest.raises(DependencyError, match="Invalid analysis"):
        analyzer(other if fallback_fails else source)
    assert chunks.closed


def test_replacing_and_closing_prefetch_drains_unconsumed_work(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_prefetch as subject

    first, second = _voice(tmp_path / "first.wav"), _voice(tmp_path / "second.wav")
    chunks = []

    def schedule(path, cancel):
        assert not chunks or chunks[-1].closed
        chunks.append(ChunkResults())
        return chunks[-1]

    monkeypatch.setattr(subject, "prefetch_pitch", schedule)
    analyzer = subject.LocalPitchAnalyzer(threading.Event(), lambda path: ())
    analyzer.prefetch(first)
    analyzer.prefetch(second)
    assert chunks[0].closed and not chunks[1].closed
    analyzer.close()
    analyzer.close()
    assert all(result.closed for result in chunks)


def test_mutation_during_prefetch_setup_closes_new_work(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_prefetch as subject

    source, chunks = _voice(tmp_path / "reference.wav"), ChunkResults()

    def schedule(path, cancel):
        with path.open("ab") as stream:
            stream.write(b"changed")
        return chunks

    monkeypatch.setattr(subject, "prefetch_pitch", schedule)
    analyzer = subject.LocalPitchAnalyzer(threading.Event(), lambda path: ())
    with pytest.raises(DependencyError, match="changed"):
        analyzer.prefetch(source)
    assert chunks.closed


def test_prefetch_is_lazy_serial_outside_render_context(tmp_path, monkeypatch):
    from backend.recordings import studio_pitch_analysis as analysis
    from backend.recordings.studio_pitch_prefetch import LocalPitchAnalyzer

    threads = []

    def estimate(samples, cancel):
        threads.append(threading.get_ident())
        size = 1 + len(samples) // 160
        return np.ones(size), np.ones(size), np.ones(size, dtype=bool)

    monkeypatch.setattr(analysis, "_estimate", estimate)
    source = _voice(tmp_path / "reference.wav")
    analyzer = LocalPitchAnalyzer(threading.Event(), lambda path: ())
    analyzer.prefetch(source)
    assert not threads
    assert len(analyzer(source)) == 210
    assert threads == [threading.get_ident()]
