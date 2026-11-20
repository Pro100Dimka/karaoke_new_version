"""Compact return PCM with exact virtual silence on the original sample timeline."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt

from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_regional_returns import AmbienceRegion, EchoRegion, convolve_return

_BLOCK = 32768


@dataclass(frozen=True, slots=True)
class ReturnSpan:
    offset_frames: int
    total_frames: int


RegionalReader = tuple[str, sf.SoundFile, float, float, ReturnSpan | None]


def _support_bounds(
    region: AmbienceRegion | EchoRegion, rate: int, frames: int, impulse_frames: int
) -> tuple[int, int]:
    # A sample of margin protects floating-point comparisons at the fade boundaries.
    first = max(0, math.floor((region.start - 0.125) * rate) - 1)
    onset = min(frames, first // _BLOCK * _BLOCK)
    last = max(0, math.ceil((region.end + 0.125) * rate) + 1)
    excitation_end = min(frames, math.ceil(last / _BLOCK) * _BLOCK)
    # Keep complete original FFT blocks and drain every overlap sample, including roundoff.
    tail_blocks = math.ceil(max(0, impulse_frames - 1) / _BLOCK)
    end = min(frames, excitation_end + tail_blocks * _BLOCK)
    return onset, max(onset, end)


def convolve_compact_return(
    voice: Path,
    target: Path,
    region: AmbienceRegion | EchoRegion,
    impulse: np.ndarray,
    cancel: threading.Event,
) -> ReturnSpan:
    _check_cancel(cancel)
    info = sf.info(voice)
    bounds = _support_bounds(region, info.samplerate, info.frames, len(impulse))
    convolve_return(voice, target, region, impulse, cancel, frame_bounds=bounds)
    return ReturnSpan(bounds[0], info.frames)


def read_return(
    reader: sf.SoundFile, span: ReturnSpan | None, offset: int, count: int
) -> np.ndarray | None:
    if span is None:
        full: np.ndarray = reader.read(count, always_2d=True)
        return full
    first = max(offset, span.offset_frames)
    last = min(offset + count, span.offset_frames + reader.frames)
    if last <= first:
        return None
    local = first - span.offset_frames
    if reader.tell() != local:
        reader.seek(local)
    samples = np.zeros((count, 2))
    samples[first - offset : last - offset] = reader.read(last - first, always_2d=True)
    return samples


def read_regional(readers: list[RegionalReader], count: int, offset: int) -> dict[str, np.ndarray]:
    result: dict[str, np.ndarray] = {}
    for name, reader, mid_gain, side_gain, span in readers:
        if name not in result:
            result[name] = np.zeros((count, 2))
        block = read_return(reader, span, offset, count)
        if block is None:
            result[name] += 0.0  # Retain the original addition's signed-zero behavior.
            continue
        mid = block.mean(axis=1) * mid_gain
        side = (block[:, 0] - block[:, 1]) * 0.5 * side_gain
        result[name] += np.column_stack((mid + side, mid - side))
    return result


def compact_field_envelopes(
    path: Path, span: ReturnSpan, band_index: int, frame_stop: int, cancel: threading.Event
) -> np.ndarray:
    with sf.SoundFile(path) as source:
        if source.channels < 2 or source.samplerate <= 7000:
            return np.empty((0, 1, 2))
        step = max(1, round(source.samplerate * 0.02))
        block_size = step * 150
        band = butter(
            2,
            ((150, 500), (500, 3500))[band_index],
            fs=source.samplerate,
            btype="bandpass",
            output="sos",
        )
        state = np.zeros((len(band), 2, 2))
        result = np.zeros((span.total_frames // step, 1, 2))
        first = span.offset_frames // block_size * block_size
        stop = min(span.total_frames, math.ceil(frame_stop / 150) * block_size)
        for offset in range(first, stop, block_size):
            _check_cancel(cancel)
            length = min(block_size, span.total_frames - offset)
            block = read_return(source, span, offset, length)
            if block is None:
                block = np.zeros((length, 2))
            samples, state = sosfilt(band, block[:, :2], axis=0, zi=state)
            mid_side = np.column_stack((samples.mean(axis=1), np.diff(samples, axis=1)[:, 0] / 2))
            count = length // step
            power = np.mean(mid_side[: count * step].reshape(count, step, 2) ** 2, axis=1)
            result[offset // step : offset // step + count, 0] = power
        return result
