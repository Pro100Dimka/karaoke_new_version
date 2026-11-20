"""The render CPU budget schedules independent pitch chunks in source order."""

import threading

import numpy as np
import pytest
import soundfile as sf


def test_pitch_chunks_use_concurrent_independent_audio_handles(tmp_path, monkeypatch):
    from backend.recordings import studio_parallel, studio_pitch_analysis as subject

    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 8)
    monkeypatch.setattr(subject, "_CHUNK_SECONDS", 0.5)
    source = tmp_path / "voice.wav"
    sf.write(source, np.ones(16000 * 2) * 0.1, 16000, subtype="FLOAT")
    barrier = threading.Barrier(2)
    handles, readers = [], []
    original = subject._read_chunk

    def read(audio, first, last):
        handles.append(audio)
        readers.append(threading.get_ident())
        barrier.wait(timeout=2)
        return original(audio, first, last)

    def estimate(samples, cancel):
        size = 1 + len(samples) // 160
        return np.full(size, 220.0), np.ones(size), np.ones(size, dtype=bool)

    monkeypatch.setattr(subject, "_read_chunk", read)
    monkeypatch.setattr(subject, "_estimate", estimate)
    with studio_parallel.render_execution(threading.Event(), workers=2):
        points = subject.analyze_pitch(source, threading.Event())
    assert len(points) == 200
    assert len({id(handle) for handle in handles}) == 4
    assert len(set(readers)) == 2
    assert all(handle.closed for handle in handles)
    assert [point.time for point in points] == [index / 100 for index in range(200)]


@pytest.mark.parametrize("frequency", [65, 220])
def test_parallel_pitch_keeps_every_point_exact(tmp_path, monkeypatch, frequency):
    from backend.recordings import studio_parallel, studio_pitch_analysis as subject

    monkeypatch.setattr(studio_parallel, "logical_cpu_count", lambda: 8)
    monkeypatch.setattr(subject, "_CHUNK_SECONDS", 1)
    rate = 44100
    time = np.arange(rate * 3 + 19) / rate
    hz = frequency * 2 ** (0.3 * np.sin(2 * np.pi * 5 * time) / 12)
    phase = 2 * np.pi * np.cumsum(hz) / rate
    samples = 0.1 * np.sin(phase) + 0.03 * np.sin(phase * 2)
    source = tmp_path / "voice.wav"
    sf.write(source, np.column_stack([samples, -samples]), rate, subtype="FLOAT")
    expected = subject.analyze_pitch(source, threading.Event())
    with studio_parallel.render_execution(threading.Event(), workers=2):
        actual = subject.analyze_pitch(source, threading.Event())
    assert actual == expected
