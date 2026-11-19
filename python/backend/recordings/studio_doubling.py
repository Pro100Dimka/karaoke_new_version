"""Parallel voiced doubles synthesized only from the performer's direct PCM."""

from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
import math
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel, _temporary_wave
from backend.recordings.studio_layer_types import VocalLayerRegion

_BLOCK_FRAMES = 32768
_MAX_DELAY_MS = 120.0


def _output_channels(source: int, requested: int | None) -> int:
    channels = source if requested is None else requested
    if source not in (1, 2) or channels not in (1, 2):
        raise DependencyError(
            "StudioMasterInvalidLayerChannels", "Unsupported vocal layer channels"
        )
    return channels


def _selected_regions(
    regions: Sequence[VocalLayerRegion], duration: float
) -> list[VocalLayerRegion]:
    selected = []
    for region in regions:
        if region.kind != "double":
            continue
        values = (
            region.start,
            region.end,
            region.gain,
            region.delay_ms,
            region.modulation_ms,
            region.pan,
            region.semitones,
        )
        if (
            not np.isfinite(values).all()
            or region.end <= region.start
            or region.gain < 0
            or abs(region.pan) > 1
            or region.modulation_ms < 0
            or region.delay_ms < region.modulation_ms
            or region.delay_ms + region.modulation_ms > _MAX_DELAY_MS
            or region.semitones != 0
        ):
            raise DependencyError(
                "StudioMasterInvalidLayerPlan", "Invalid vocal doubling parameters"
            )
        start, end = max(0.0, region.start), min(duration, region.end)
        if end > start and region.gain > 0:
            selected.append(replace(region, start=start, end=end))
    return selected


def _read_context(
    audio: sf.SoundFile, first: int, count: int, channels: int
) -> NDArray[np.float64]:
    left = max(0, -first)
    audio.seek(max(0, first))
    samples = audio.read(min(count - left, audio.frames - audio.tell()), always_2d=True)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    if samples.shape[1] != channels:
        samples = (
            samples.mean(axis=1, keepdims=True) if channels == 1 else samples.repeat(2, axis=1)
        )
    return np.pad(samples, ((left, count - left - len(samples)), (0, 0)))


def _fractional_delay(
    samples: NDArray[np.float64], positions: NDArray[np.float64], first: int
) -> NDArray[np.float64]:
    """Four-point Lagrange interpolation; integer delays retain their sample positions."""
    integral = np.floor(positions).astype(np.int64)
    fraction = (positions - integral)[:, None]
    index = integral - first
    weights = (
        -fraction * (fraction - 1) * (fraction - 2) / 6,
        (fraction + 1) * (fraction - 1) * (fraction - 2) / 2,
        -(fraction + 1) * fraction * (fraction - 2) / 2,
        (fraction + 1) * fraction * (fraction - 1) / 6,
    )
    return np.asarray(
        sum(samples[index + offset] * weight for offset, weight in zip((-1, 0, 1, 2), weights)),
        dtype=np.float64,
    )


def _delay_seconds(time: NDArray[np.float64], region: VocalLayerRegion) -> NDArray[np.float64]:
    # Smooth deterministic motion, unlike a fixed comb filter or random per-block jumps.
    phase = (region.pan + 1) * math.pi / 2
    elapsed = time - region.start
    motion = 0.7 * np.sin(2 * math.pi * 0.37 * elapsed + phase)
    motion += 0.3 * np.sin(2 * math.pi * 0.61 * elapsed + phase * 0.73)
    return np.asarray((region.delay_ms + region.modulation_ms * motion) / 1000, dtype=np.float64)


def _region_gain(
    time: NDArray[np.float64], source_time: NDArray[np.float64], region: VocalLayerRegion
) -> NDArray[np.float64]:
    fade = min(0.02, (region.end - region.start) / 4)
    # Start with this phrase's samples, never a delayed fragment from the previous region.
    position = np.minimum((source_time - region.start) / fade, (region.end - time) / fade)
    return np.asarray(0.5 - 0.5 * np.cos(math.pi * np.clip(position, 0, 1)), dtype=np.float64)


def _layer(
    context: NDArray[np.float64],
    first: int,
    time: NDArray[np.float64],
    rate: int,
    region: VocalLayerRegion,
) -> NDArray[np.float64]:
    source_time = time - _delay_seconds(time, region)
    delayed = _fractional_delay(context, source_time * rate, first)
    gain = _region_gain(time, source_time, region) * region.gain
    pan = np.sqrt([(1 - region.pan) / 2, (1 + region.pan) / 2]) if context.shape[1] == 2 else 1
    return np.asarray(delayed * gain[:, None] * pan, dtype=np.float64)


def render_double_layers(
    direct: Path,
    target: Path,
    regions: Sequence[VocalLayerRegion],
    cancel: threading.Event,
    *,
    channels: int | None = None,
) -> dict[str, object]:
    """Write one wet-only double bus; the caller adds it to the finished vocal once."""
    _check_cancel(cancel)
    info = sf.info(direct)
    channels = _output_channels(info.channels, channels)
    selected = _selected_regions(regions, info.duration)
    maximum = max((r.delay_ms + r.modulation_ms for r in selected), default=0.0)
    history = math.ceil(maximum * info.samplerate / 1000) + 2
    peak = 0.0
    with (
        sf.SoundFile(direct) as audio,
        _temporary_wave(target, samplerate=info.samplerate, channels=channels) as output,
    ):
        for offset in range(0, info.frames, _BLOCK_FRAMES):
            _check_cancel(cancel)
            count = min(_BLOCK_FRAMES, info.frames - offset)
            context = _read_context(audio, offset - history, count + history + 2, channels)
            time = np.arange(offset, offset + count, dtype=np.float64) / info.samplerate
            wet = np.zeros((count, channels), dtype=np.float64)
            for region in selected:
                if region.start < (offset + count) / info.samplerate and region.end > time[0]:
                    wet += _layer(context, offset - history, time, info.samplerate, region)
            peak = max(peak, float(np.max(np.abs(wet))))
            output.write(wet)
    return {
        "applied": peak > 0,
        "method": "fractional-modulated-double",
        "source": "user-direct",
        "regionCount": len(selected),
        "maxDelayMs": maximum,
        "wetPeak": peak,
    }
