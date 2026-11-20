"""Measure related RMS bands with one decode and one FFT per channel mode."""

from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from pathlib import Path
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _PROFILE_SECONDS, _check_cancel
from backend.recordings.studio_parallel import ordered_map

FloatArray = NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class ProfileRequest:
    center: bool = False
    band_hz: tuple[float, float] | None = None


def _append_profiles(
    frames: FloatArray,
    rate: int,
    requests: tuple[ProfileRequest, ...],
    levels: dict[ProfileRequest, list[float]],
) -> None:
    if not frames.size:
        return
    spectrum, hz, normalization = None, None, 1.0
    if any(request.band_hz is not None for request in requests):
        length = frames.shape[1]
        window = np.hanning(length)[None, :, None]
        spectrum = np.fft.rfft(frames * window, axis=1)
        hz = np.fft.rfftfreq(length, 1 / rate)
        normalization = max(1.0, length * float(np.sum(window**2)) * frames.shape[2])
    for request in requests:
        if request.band_hz is None:
            power = np.mean(frames * frames, axis=(1, 2))
        else:
            assert spectrum is not None and hz is not None
            low, high = request.band_hz
            power = (
                2
                * np.sum(np.abs(spectrum[:, (hz >= low) & (hz <= high)]) ** 2, axis=(1, 2))
                / normalization
            )
        levels[request].extend((10 * np.log10(np.maximum(1e-12, power))).tolist())


def _measure_block(
    samples: FloatArray,
    rate: int,
    frame_size: int,
    groups: dict[bool, tuple[ProfileRequest, ...]],
    levels: dict[ProfileRequest, list[float]],
) -> None:
    complete = len(samples) // frame_size * frame_size
    for center, requests in groups.items():
        block = samples.mean(axis=1, keepdims=True) if center else samples
        # The last partial frame retains its own taper and transform length.
        for frames in (
            block[:complete].reshape(-1, frame_size, block.shape[1]),
            block[complete:][None, :, :],
        ):
            _append_profiles(frames, rate, requests, levels)


def _block_profiles(
    samples: FloatArray,
    *,
    rate: int,
    frame_size: int,
    groups: dict[bool, tuple[ProfileRequest, ...]],
    cancel: threading.Event,
) -> dict[ProfileRequest, list[float]]:
    _check_cancel(cancel)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    levels: dict[ProfileRequest, list[float]] = {
        request: [] for requests in groups.values() for request in requests
    }
    _measure_block(samples, rate, frame_size, groups, levels)
    return levels


def measure_profiles(
    path: Path,
    cancel: threading.Event,
    requests: tuple[ProfileRequest, ...],
    *,
    frame_seconds: float = _PROFILE_SECONDS,
) -> tuple[FloatArray, ...]:
    unique = tuple(dict.fromkeys(requests))
    if not unique:
        raise ValueError("At least one profile must be requested")
    levels: dict[ProfileRequest, list[float]] = {request: [] for request in unique}
    groups = {
        center: tuple(request for request in unique if request.center == center)
        for center in dict.fromkeys(request.center for request in unique)
    }
    with sf.SoundFile(path) as source:
        frame_size = max(1, round(source.samplerate * frame_seconds))
        worker = partial(
            _block_profiles,
            rate=source.samplerate,
            frame_size=frame_size,
            groups=groups,
            cancel=cancel,
        )
        blocks = source.blocks(blocksize=frame_size * 32, dtype="float64", always_2d=True)
        for result in ordered_map(worker, blocks):
            _check_cancel(cancel)
            for request, values in result.items():
                levels[request].extend(values)
    if not levels[unique[0]]:
        raise DependencyError("StudioMasterSilentTrack", "Recording contains no audio")
    measured = {request: np.asarray(values, dtype=np.float64) for request, values in levels.items()}
    return tuple(measured[request] for request in requests)
