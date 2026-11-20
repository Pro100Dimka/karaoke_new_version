"""Dispatch unchanged frame measurements through the bounded render executor."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_adaptive_features as features
from backend.recordings import studio_parallel as parallel


def _source(tmp_path, rate, channels):
    samples = np.random.default_rng(117).normal(0, 0.08, (round(rate * 7.133), channels))
    path = tmp_path / "frames.wav"
    sf.write(path, samples, rate, subtype="DOUBLE")
    return path


def _serial_measurements(path):
    samples, rate = sf.read(path, dtype="float64", always_2d=True)
    count = round(rate * 0.02)
    frequency = np.fft.rfftfreq(count, 1 / rate)
    window = np.hanning(count)
    masks = [(frequency >= lo) & (frequency < min(hi, rate / 2)) for lo, hi in features.BAND_EDGES]
    rows = [
        features._frame_statistics(samples[start : start + count * 128], count, window, masks)
        for start in range(0, len(samples), count * 128)
    ]
    return tuple(np.concatenate([row[index] for row in rows]) for index in range(4)) + (
        rate,
        len(samples),
        samples.shape[1],
    )


@pytest.mark.parametrize("rate,channels", [(8000, 1), (44100, 2), (48000, 4)])
def test_frame_measurements_dispatch_lazy_blocks_with_exact_order(
    tmp_path, monkeypatch, rate, channels
):
    path = _source(tmp_path, rate, channels)
    expected = _serial_measurements(path)
    dispatched = []

    def tracked(function, iterable):
        assert iter(iterable) is iterable, "Keep SoundFile reads lazy in the owning producer"
        for block in iterable:
            dispatched.append(len(block))
            yield function(block)

    monkeypatch.setattr(features, "ordered_map", tracked, raising=False)
    actual = features._measure_blocks(path, threading.Event())
    for observed, reference in zip(actual, expected):
        np.testing.assert_array_equal(observed, reference)
    assert len(dispatched) == 3, "Every independent frame block must use the shared executor"


def test_frame_measurement_checks_cancel_before_dispatched_work(tmp_path, monkeypatch):
    path = _source(tmp_path, 8000, 1)
    cancel = threading.Event()

    def cancelled(function, iterable):
        block = next(iter(iterable))
        cancel.set()
        yield function(block)

    monkeypatch.setattr(features, "ordered_map", cancelled, raising=False)
    with pytest.raises(DomainError, match="Studio master was cancelled"):
        features._measure_blocks(path, cancel)


def test_concurrent_measurements_keep_file_reads_in_producer_and_samples_exact(
    tmp_path, monkeypatch
):
    path = _source(tmp_path, 44100, 2)
    expected = _serial_measurements(path)
    producer = threading.get_ident()
    original_measure, original_read = features._frame_statistics, sf.SoundFile.read
    start = threading.Barrier(2)
    entered = threading.local()
    worker_threads, read_threads = set(), []

    def measured(*args):
        worker_threads.add(threading.get_ident())
        if not getattr(entered, "ready", False):
            entered.ready = True
            start.wait(timeout=5)
        return original_measure(*args)

    def read(*args, **kwargs):
        read_threads.append(threading.get_ident())
        return original_read(*args, **kwargs)

    monkeypatch.setattr(features, "_frame_statistics", measured)
    monkeypatch.setattr(sf.SoundFile, "read", read)
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)
    cancel = threading.Event()
    with parallel.render_execution(cancel, workers=2):
        actual = features._measure_blocks(path, cancel)
    for observed, reference in zip(actual, expected):
        np.testing.assert_array_equal(observed, reference)
    assert len(worker_threads) == 2 and producer not in worker_threads
    assert read_threads and set(read_threads) == {producer}


def test_nonfinite_samples_fail_from_concurrent_final_block(tmp_path, monkeypatch):
    path = _source(tmp_path, 8000, 1)
    with sf.SoundFile(path, "r+") as audio:
        audio.seek(audio.frames - 1)
        audio.write(np.asarray([np.nan]))
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)
    cancel = threading.Event()
    with parallel.render_execution(cancel, workers=2):
        with pytest.raises(DomainError, match="Audio contains non-finite samples"):
            features._measure_blocks(path, cancel)
