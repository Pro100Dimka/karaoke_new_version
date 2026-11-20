"""Exact-zero convolution work may be skipped without changing a return sample."""

import threading

import numpy as np
import pytest
import soundfile as sf
from scipy.fft import irfft, next_fast_len, rfft

from backend.domain_errors import DomainError
from backend.recordings import studio_regional_returns as returns


BLOCK = 32768
RATE = 96000


def _fixture(channels, kind):
    rng = np.random.default_rng(2471)
    count = 6 * BLOCK + 713
    audio = rng.normal(0, 0.15, (count, channels)).astype(np.float32)
    start, end = 1.5 * BLOCK / RATE, 2.3 * BLOCK / RATE
    if kind == "silent-source":
        audio[:] = 0
        audio[2 * BLOCK - 521 : 2 * BLOCK - 401] = 0.2
        start, end = 0, count / RATE
    elif kind == "final-partial":
        start, end = 5.4 * BLOCK / RATE, count / RATE
    elif kind == "all-silent":
        audio[:] = 0
    elif kind == "opposite-phase":
        audio[:, 1] = -audio[:, 0]
    impulse = rng.normal(0, 0.01, (round(RATE * 0.64), 2))
    impulse *= np.exp(-4 * np.arange(len(impulse)) / len(impulse))[:, None]
    region = returns.AmbienceRegion(
        start,
        end,
        np.ones(31),
        (500, 3500),
        1,
        0.1,
        0,
        1,
        "fixture",
        valid_start=0,
        valid_end=count / RATE,
    )
    return audio, region, impulse


def _dense_return(audio, region, impulse):
    """Frozen pre-optimization overlap-add, including every zero-input FFT."""
    size = next_fast_len(BLOCK + len(impulse) - 1, real=True)
    response = rfft(impulse, n=size, axis=0)
    overlap = np.zeros((len(impulse) - 1, 2))
    blocks = []
    active = 0
    for offset in range(0, len(audio), BLOCK):
        block = audio[offset : offset + BLOCK]
        times = (offset + np.arange(len(block))) / RATE
        mono = block.mean(axis=1) * returns._input_curve(times, region)
        active += int(np.any(mono))
        wet = irfft(rfft(mono, n=size)[:, None] * response, n=size, axis=0)
        wet = wet[: len(block) + len(impulse) - 1]
        wet[: len(overlap)] += overlap
        overlap = wet[len(block) :].copy()
        blocks.append(wet[: len(block)])
    return np.concatenate(blocks).astype(np.float32), active


@pytest.mark.parametrize("channels", [1, 2])
@pytest.mark.parametrize("kind", ["gated", "silent-source", "final-partial", "all-silent"])
def test_zero_excitation_skips_fft_and_preserves_exact_pcm(tmp_path, monkeypatch, channels, kind):
    audio, region, impulse = _fixture(channels, kind)
    source, target = tmp_path / "source.wav", tmp_path / "return.wav"
    sf.write(source, audio, RATE, subtype="FLOAT")
    decoded, _ = sf.read(source, always_2d=True)
    expected, active = _dense_return(decoded, region, impulse)
    calls = {"rfft": 0, "irfft": 0}

    def forward(*args, **kwargs):
        calls["rfft"] += 1
        return rfft(*args, **kwargs)

    def inverse(*args, **kwargs):
        calls["irfft"] += 1
        return irfft(*args, **kwargs)

    monkeypatch.setattr(returns, "rfft", forward)
    monkeypatch.setattr(returns, "irfft", inverse)
    returns.convolve_return(source, target, region, impulse, threading.Event())
    actual, rate = sf.read(target, dtype="float32", always_2d=True)
    assert rate == RATE and actual.shape == (len(audio), 2)
    np.testing.assert_array_equal(actual.view(np.uint32), expected.view(np.uint32))
    assert calls == {"rfft": active + 1, "irfft": active}
    if kind == "silent-source":
        assert np.any(actual[2 * BLOCK : 3 * BLOCK])
        assert np.any(actual[3 * BLOCK : 4 * BLOCK])
        assert not np.any(actual[4 * BLOCK :])


def test_opposite_phase_stereo_has_no_excitation_or_block_fft(tmp_path, monkeypatch):
    audio, region, impulse = _fixture(2, "opposite-phase")
    source, target = tmp_path / "source.wav", tmp_path / "return.wav"
    sf.write(source, audio, RATE, subtype="FLOAT")

    def unexpected_inverse(*args, **kwargs):
        pytest.fail("A zero mid signal cannot require an inverse FFT")

    monkeypatch.setattr(returns, "irfft", unexpected_inverse)
    returns.convolve_return(source, target, region, impulse, threading.Event())
    actual, _ = sf.read(target, always_2d=True)
    assert not np.any(actual)


def test_skipped_silent_blocks_still_check_cancellation(tmp_path, monkeypatch):
    audio, region, impulse = _fixture(2, "all-silent")
    source, target = tmp_path / "source.wav", tmp_path / "return.wav"
    sf.write(source, audio, RATE, subtype="FLOAT")
    cancel = threading.Event()
    check = returns._check_cancel
    calls = 0

    def cancel_on_third_block(event):
        nonlocal calls
        calls += 1
        if calls == 3:
            event.set()
        check(event)

    monkeypatch.setattr(returns, "_check_cancel", cancel_on_third_block)
    with pytest.raises(DomainError, match="cancelled"):
        returns.convolve_return(source, target, region, impulse, cancel)
    assert calls == 3
