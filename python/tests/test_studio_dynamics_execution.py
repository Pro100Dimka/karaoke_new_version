"""Keep overlapped dynamics PCM and serial energy accumulation unchanged."""

import threading

import numpy as np
import pytest
from scipy.signal import resample_poly
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings import studio_adaptive_dynamics as dynamics
from backend.recordings import studio_parallel as parallel
from backend.recordings.studio_adaptive_features import analyze_voice


def _source(tmp_path, rate, channels):
    samples = np.random.default_rng(72).normal(0, 0.12, (2 * 65536 + 177, channels))
    samples[65535:65538] = np.asarray([0.8, -0.9, 0.7])[:, None]
    source = tmp_path / "source.wav"
    sf.write(source, samples, rate, subtype="DOUBLE")
    return source


def _serial_saturation(source, scale):
    rows, before, after = [], 0.0, 0.0
    with sf.SoundFile(source) as audio:
        for offset in range(0, audio.frames, 65536):
            count = min(65536, audio.frames - offset)
            start, end = max(0, offset - 96), min(audio.frames, offset + count + 96)
            audio.seek(start)
            block = audio.read(end - start, dtype="float64", always_2d=True)
            expanded = resample_poly(block, 4, 1, axis=0)
            wet = resample_poly(np.tanh(expanded * scale) / scale, 1, 4, axis=0)
            begin = offset - start
            dry = block[begin : begin + count]
            colored = dry + 0.06 * (wet[begin : begin + count] - dry)
            before += float(np.sum(dry**2))
            after += float(np.sum(colored**2))
            rows.append(colored.astype(np.float32))
    return np.concatenate(rows), (before, after)


def _serial_deess(source, features, reduction, band):
    nfft = 1024 if features.rate >= 24000 else 512
    rows = []
    with sf.SoundFile(source) as audio:
        for offset in range(0, audio.frames, nfft * 64):
            count = min(nfft * 64, audio.frames - offset)
            start, end = max(0, offset - nfft), min(audio.frames, offset + count + nfft)
            audio.seek(start)
            samples = audio.read(end - start, dtype="float64", always_2d=True)
            if len(samples) < nfft:
                samples = np.pad(samples, ((0, nfft - len(samples)), (0, 0)))
            restored = dynamics._deess_block(samples, start, features, reduction, band, nfft)
            rows.append(restored[:, offset - start : offset - start + count].T.astype(np.float32))
    return np.concatenate(rows)


def _track_dispatch(monkeypatch):
    dispatched = []

    def tracked(function, iterable):
        assert iter(iterable) is iterable, "Read overlapping source blocks lazily"
        for block in iterable:
            dispatched.append(1)
            yield function(block)

    monkeypatch.setattr(dynamics, "ordered_map", tracked, raising=False)
    return dispatched


@pytest.mark.parametrize("rate,channels", [(8000, 1), (44100, 2), (48000, 4)])
def test_saturation_dispatch_preserves_exact_pcm_and_energy(tmp_path, monkeypatch, rate, channels):
    source = _source(tmp_path, rate, channels)
    expected, energy = _serial_saturation(source, 2.71)
    dispatched = _track_dispatch(monkeypatch)
    target = tmp_path / "colored.wav"
    actual = dynamics._write_saturation(source, target, 2.71, threading.Event())
    np.testing.assert_array_equal(sf.read(target, dtype="float32", always_2d=True)[0], expected)
    assert actual == energy
    assert len(dispatched) == 3, "Every independent saturation block must use the render executor"


@pytest.mark.parametrize("rate,channels", [(8000, 1), (44100, 2)])
def test_deess_preserves_exact_overlapped_pcm(tmp_path, rate, channels):
    source = _source(tmp_path, rate, channels)
    cancel = threading.Event()
    measured = analyze_voice(source, cancel)
    reduction = np.linspace(0, 6, len(measured.times))
    band = (1000.0, min(7500.0, rate * 0.45))
    expected = _serial_deess(source, measured, reduction, band)
    target = tmp_path / "deessed.wav"
    dynamics._spectral_attenuation(source, target, measured, reduction, *band, cancel)
    np.testing.assert_array_equal(sf.read(target, dtype="float32", always_2d=True)[0], expected)


def test_saturation_checks_cancel_before_dispatched_work(tmp_path, monkeypatch):
    source = _source(tmp_path, 44100, 1)
    cancel = threading.Event()

    def cancelled(function, iterable):
        block = next(iter(iterable))
        cancel.set()
        yield function(block)

    monkeypatch.setattr(dynamics, "ordered_map", cancelled, raising=False)
    with pytest.raises(DomainError, match="Studio master was cancelled"):
        dynamics._write_saturation(source, tmp_path / "out.wav", 2.71, cancel)


def _track_concurrent_worker(monkeypatch, name):
    original = getattr(dynamics, name)
    start, entered = threading.Barrier(2), threading.local()
    threads = set()

    def tracked(*args):
        threads.add(threading.get_ident())
        if not getattr(entered, "ready", False):
            entered.ready = True
            start.wait(timeout=5)
        return original(*args)

    monkeypatch.setattr(dynamics, name, tracked)
    return threads


def _track_audio_io(monkeypatch):
    threads = []

    def tracked(original):
        def invoke(*args, **kwargs):
            threads.append(threading.get_ident())
            return original(*args, **kwargs)

        return invoke

    for name in ("seek", "read", "write"):
        monkeypatch.setattr(sf.SoundFile, name, tracked(getattr(sf.SoundFile, name)))
    return threads


def test_concurrent_saturation_keeps_exact_pcm_and_all_io_in_producer(tmp_path, monkeypatch):
    source = _source(tmp_path, 44100, 2)
    cancel = threading.Event()
    expected, energy = _serial_saturation(source, 2.71)
    workers = _track_concurrent_worker(monkeypatch, "_saturation_block")
    io_threads = _track_audio_io(monkeypatch)
    monkeypatch.setattr(parallel, "logical_cpu_count", lambda: 8)
    target = tmp_path / "concurrent.wav"
    with parallel.render_execution(cancel, workers=2):
        assert dynamics._write_saturation(source, target, 2.71, cancel) == energy
    np.testing.assert_array_equal(sf.read(target, dtype="float32", always_2d=True)[0], expected)
    assert len(workers) == 2 and threading.get_ident() not in workers
    assert io_threads and set(io_threads) == {threading.get_ident()}


@pytest.mark.parametrize("rate,count", [(8000, 1), (16000, 511), (44100, 1023)])
def test_short_context_blocks_preserve_padding_and_length(tmp_path, rate, count):
    source = tmp_path / "short.wav"
    sf.write(source, np.random.default_rng(17).normal(0, 0.1, (count, 2)), rate, subtype="DOUBLE")
    cancel = threading.Event()
    measured = analyze_voice(source, cancel)
    reduction, band = np.linspace(0, 6, len(measured.times)), (1000.0, min(7500.0, rate * 0.45))
    expected_color, energy = _serial_saturation(source, 2.71)
    expected_deess = _serial_deess(source, measured, reduction, band)
    colored, deessed = tmp_path / "color.wav", tmp_path / "deess.wav"
    with parallel.render_execution(cancel, workers=2):
        assert dynamics._write_saturation(source, colored, 2.71, cancel) == energy
        dynamics._spectral_attenuation(source, deessed, measured, reduction, *band, cancel)
    for path, expected in ((colored, expected_color), (deessed, expected_deess)):
        actual, actual_rate = sf.read(path, dtype="float32", always_2d=True)
        assert actual.shape == (count, 2) and actual_rate == rate
        np.testing.assert_array_equal(actual, expected)
