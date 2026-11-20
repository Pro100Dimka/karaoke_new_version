"""Scratch PCM closes completely without Python callbacks or durability syncs."""

import numpy as np
import pytest
import soundfile as sf

from backend.recordings.studio_audio import _temporary_wave


def test_scratch_wave_uses_native_io_and_keeps_exact_float_samples(tmp_path, monkeypatch):
    callbacks = []
    original = sf.SoundFile._init_virtual_io

    def virtual(self, source):
        callbacks.append(source)
        return original(self, source)

    monkeypatch.setattr(sf.SoundFile, "_init_virtual_io", virtual)
    source = np.random.default_rng(52).normal(0, 1.5, (190003, 2))
    source[:3] = [[-0.0, 0.0], [np.finfo(np.float32).tiny, -np.finfo(np.float32).tiny], [1.4, -1.3]]
    target = tmp_path / "scratch.wav"
    with _temporary_wave(target, samplerate=44100, channels=2) as output:
        for offset in range(0, len(source), 1931):
            output.write(source[offset : offset + 1931])
    actual, rate = sf.read(target, dtype="float32", always_2d=True)
    assert rate == 44100 and sf.info(target).frames == len(source)
    assert actual.tobytes() == source.astype(np.float32).tobytes()
    assert not callbacks, "Scratch writes must not serialize through Python virtual I/O"
    target.unlink()


def test_scratch_writer_closes_before_exception_reaches_temporary_cleanup(tmp_path):
    target = tmp_path / "scratch.wav"
    with pytest.raises(ValueError, match="cancelled stage"):
        with _temporary_wave(target, samplerate=8000, channels=1) as output:
            output.write(np.ones(77, dtype=np.float32))
            raise ValueError("cancelled stage")
    assert output.closed
    assert sf.info(target).frames == 77
    target.unlink()
