"""Regression cases for streamed spectral unmasking with float32 FFT buffers."""

import threading

import numpy as np
import pytest
import soundfile as sf

from backend.domain_errors import DomainError
from backend.recordings.studio_spectrum import _unmask_backing


@pytest.mark.parametrize('channels', [1, 2])
@pytest.mark.parametrize('frames', [1, 4096, 16384])
def test_spectral_unmask_preserves_frame_count_and_silence(tmp_path, channels, frames):
    music = tmp_path / 'music.wav'
    vocal = tmp_path / 'vocal.wav'
    output = tmp_path / 'output.wav'
    silence = np.zeros((frames, channels), dtype=np.float32)
    sf.write(music, silence, 48000, subtype='FLOAT')
    sf.write(vocal, silence, 48000, subtype='FLOAT')
    report = _unmask_backing(music, vocal, output, np.zeros(10, dtype=bool), threading.Event())
    rendered, rate = sf.read(output, dtype='float32', always_2d=True)
    assert rate == 48000
    assert rendered.shape == silence.shape
    np.testing.assert_array_equal(rendered, silence)
    assert report['limitDb'] == 1.5


def test_spectral_unmask_keeps_stereo_and_finite_samples(tmp_path):
    sr = 48000
    t = np.arange(12000, dtype=np.float32) / sr
    wave = 0.25 * np.sin(2 * np.pi * 440 * t)
    music = np.column_stack([wave, wave * 0.7]).astype(np.float32)
    vocal = np.column_stack([wave * 0.2, wave * 0.3]).astype(np.float32)
    sf.write(tmp_path / 'music.wav', music, sr, subtype='FLOAT')
    sf.write(tmp_path / 'vocal.wav', vocal, sr, subtype='FLOAT')
    _unmask_backing(tmp_path / 'music.wav', tmp_path / 'vocal.wav',
                    tmp_path / 'out.wav', np.ones(10, dtype=bool), threading.Event())
    result, _ = sf.read(tmp_path / 'out.wav', dtype='float32', always_2d=True)
    assert result.shape == music.shape
    assert np.isfinite(result).all()
    assert np.max(np.abs(result)) <= 1.1 * np.max(np.abs(music))


def test_spectral_unmask_cancellation(tmp_path):
    for name in ('music.wav', 'voice.wav'):
        sf.write(tmp_path / name, np.zeros((4096, 1), dtype=np.float32), 48000)
    cancelled = threading.Event()
    cancelled.set()
    with pytest.raises(DomainError, match='cancel'):
        _unmask_backing(tmp_path / 'music.wav', tmp_path / 'voice.wav',
                        tmp_path / 'out.wav', np.zeros(10, dtype=bool), cancelled)
