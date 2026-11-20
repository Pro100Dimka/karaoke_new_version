"""Sequential overlapping audio reads with bounded independent cepstral transforms."""

from collections.abc import Callable, Iterator
from functools import partial
import threading

import numpy as np
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_parallel import ordered_map


def _windows(
    source: sf.SoundFile,
    positions: np.ndarray,
    energies: list[float],
    cancel: threading.Event,
) -> Iterator[np.ndarray]:
    rate, block = source.samplerate, source.samplerate * 2
    previous = np.empty((0, min(source.channels, 2)), dtype="float32")
    for position in positions:
        _check_cancel(cancel)
        if len(previous) == block and source.tell() == position + rate:
            tail = source.read(rate, dtype="float32", always_2d=True)[:, :2]
            samples = np.concatenate((previous[rate:], tail))
        else:
            source.seek(int(position))
            samples = source.read(block, dtype="float32", always_2d=True)[:, :2]
        if len(samples) != block:
            continue
        previous = samples
        energies.append(float(np.mean(samples.astype(np.float64) ** 2)))
        yield samples


def _transform_window(
    transform: Callable[[np.ndarray, int], np.ndarray], rate: int, samples: np.ndarray
) -> np.ndarray:
    return transform(samples, rate)


def sample_cepstra(
    source: sf.SoundFile,
    cancel: threading.Event,
    transform: Callable[[np.ndarray, int], np.ndarray],
) -> tuple[list[float], list[np.ndarray], np.ndarray]:
    energies: list[float] = []
    rate, block = source.samplerate, source.samplerate * 2
    # Keep the original one-second positions and full-song 128-window selection.
    positions = np.arange(0, source.frames - block + 1, rate, dtype=np.int64)
    if len(positions) > 128:
        positions = positions[np.linspace(0, len(positions) - 1, 128).astype(int)]
    cepstra = list(
        ordered_map(
            partial(_transform_window, transform, rate),
            _windows(source, positions, energies, cancel),
        )
    )
    return energies, cepstra, positions / rate
