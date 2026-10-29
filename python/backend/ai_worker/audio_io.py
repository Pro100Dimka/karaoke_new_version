from __future__ import annotations

from pathlib import Path

import librosa
import numpy as np
import soundfile as sf


def read_mono(path: Path, sample_rate: int) -> np.ndarray:
    """Choose channels on the complete native timeline before model resampling/chunking."""
    samples, original_rate = librosa.load(str(path), sr=None, mono=False)
    mono = _mono(samples, original_rate) if samples.ndim > 1 else samples
    return librosa.resample(mono, orig_sr=original_rate, target_sr=sample_rate)


def _mono(samples: np.ndarray, rate: float) -> np.ndarray:
    """Keep a safe average; route a stable channel where averaging loses useful energy.

    Like the realtime microphone router, hysteresis avoids chasing near-equal channels.
    This selects a signal path, not a lead singer. All decisions precede model chunking.
    """
    average = samples.mean(axis=0)
    tracks = [*samples, average]
    output = np.empty_like(average)
    step, fade = max(1, round(rate * 0.02)), max(1, round(rate * 0.005))
    selected, previous, polarity = 0, len(samples), 1
    for first in range(0, len(average), step):
        last = min(len(average), first + step)
        energy = np.mean(samples[:, first:last] ** 2, axis=1)
        strongest = int(energy.argmax())
        retained = energy[strongest] * 0.64
        if energy[selected] < retained:
            selected = strongest
        # Single-channel phrases and cancellation must not be attenuated by downmixing.
        safe_average = np.mean(average[first:last] ** 2) >= retained
        channel = len(samples) if safe_average else selected
        begin, end = max(0, first - fade), min(len(average), first + fade)
        sign = polarity
        if channel != previous:
            overlap = np.dot(tracks[previous][begin:end] * polarity, tracks[channel][begin:end])
            sign = -1 if overlap < 0 else 1
        if safe_average:
            sign = 1
        output[first:last] = tracks[channel][first:last] * sign
        if first and channel != previous:
            weight = np.linspace(0, 1, end - begin, dtype=np.float32)
            output[begin:end] = (
                tracks[previous][begin:end] * polarity * (1 - weight)
                + tracks[channel][begin:end] * sign * weight
            )
        previous, polarity = channel, sign
    return output


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """``samples`` is channels x frames float32."""
    sf.write(str(path), samples.T, sample_rate, subtype="PCM_24")
