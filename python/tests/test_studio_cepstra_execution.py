"""Only independent cepstral transforms leave the sequential audio producer."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_parallel as execution
from backend.recordings import studio_space_analysis as analysis


def _source(tmp_path, rate=8000, channels=2, seconds=8.4):
    path = tmp_path / "reference.wav"
    samples = np.random.default_rng(841).normal(0, 0.07, (round(rate * seconds), channels))
    sf.write(path, samples, rate, subtype="FLOAT")
    return path


def _measure(path, cancel):
    with sf.SoundFile(path) as source:
        return tuple(np.asarray(value) for value in analysis._sample_cepstra(source, cancel))


def _assert_exact(actual, expected):
    for first, second in zip(actual, expected, strict=True):
        assert first.dtype == second.dtype
        np.testing.assert_array_equal(first.view(np.uint8), second.view(np.uint8))


def test_transforms_use_workers_but_decoding_stays_on_the_producer(tmp_path, monkeypatch):
    path, cancel = _source(tmp_path), threading.Event()
    expected = _measure(path, cancel)
    original_read, original_transform = sf.SoundFile.read, analysis._cepstrum
    readers, transforms = set(), set()

    def read(source, *args, **kwargs):
        readers.add(threading.get_ident())
        return original_read(source, *args, **kwargs)

    def transform(samples, rate):
        transforms.add(threading.get_ident())
        return original_transform(samples, rate)

    monkeypatch.setattr(sf.SoundFile, "read", read)
    monkeypatch.setattr(analysis, "_cepstrum", transform)
    monkeypatch.setattr(execution, "logical_cpu_count", lambda: 8)
    with execution.render_execution(cancel, workers=3):
        actual = _measure(path, cancel)
    _assert_exact(actual, expected)
    assert readers == {threading.get_ident()}
    assert transforms and threading.get_ident() not in transforms


@pytest.mark.parametrize(
    "rate,channels,seconds",
    [(8000, 1, 1.5), (8000, 2, 8.4), (8000, 6, 8.4), (8000, 1, 131.4), (44100, 2, 8.4)],
)
def test_parallel_cepstra_keep_positions_energy_and_single_decode(
    tmp_path, monkeypatch, rate, channels, seconds
):
    path, cancel = _source(tmp_path, rate, channels, seconds), threading.Event()
    expected = _measure(path, cancel)
    original, decoded = sf.SoundFile.read, []

    def read(source, *args, **kwargs):
        result = original(source, *args, **kwargs)
        decoded.append(len(result))
        return result

    monkeypatch.setattr(sf.SoundFile, "read", read)
    with execution.render_execution(cancel, workers=3):
        actual = _measure(path, cancel)
    _assert_exact(actual, expected)
    assert sum(decoded) <= round(rate * seconds)


@pytest.mark.parametrize("during_read", [False, True])
def test_cepstral_producer_honors_cancellation_before_more_reads(
    tmp_path, monkeypatch, during_read
):
    path, cancel = _source(tmp_path), threading.Event()
    original, reads = sf.SoundFile.read, []

    def read(source, *args, **kwargs):
        result = original(source, *args, **kwargs)
        reads.append(len(result))
        if len(reads) == 2:
            cancel.set()
        return result

    monkeypatch.setattr(sf.SoundFile, "read", read)
    with execution.render_execution(cancel, workers=3):
        if not during_read:
            cancel.set()
        with pytest.raises(DomainError, match="cancelled"):
            _measure(path, cancel)
    assert len(reads) == (2 if during_read else 0)
