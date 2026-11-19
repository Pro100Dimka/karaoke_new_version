"""Parallel vocal layers: the finished main voice never passes through a shifter."""

from __future__ import annotations

from collections.abc import Sequence
from contextlib import ExitStack
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
import math
import threading

import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.ndimage import distance_transform_edt

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _temporary_wave
from backend.recordings.studio_doubling import render_double_layers
from backend.recordings.studio_double_calibration import (
    DoubleCalibration,
    calibrate_double_return,
    calibration_report,
    sum_with_double_budget,
)
from backend.recordings.studio_layer_types import VocalLayerRegion

_BLOCK = 32768


def _valid_target(region: VocalLayerRegion) -> bool:
    target = region.target_side_to_mid_db
    return target is None or (
        region.kind == "double" and math.isfinite(target) and -30 < target < -3
    )


def _paired_targets(regions: list[VocalLayerRegion]) -> list[VocalLayerRegion]:
    automatic = [region for region in regions if region.target_side_to_mid_db is not None]
    accepted = []
    for start, end in {(region.start, region.end) for region in automatic}:
        pair = [region for region in automatic if (region.start, region.end) == (start, end)]
        if (
            len(pair) == 2
            and pair[0].pan * pair[1].pan < 0
            and pair[0].target_side_to_mid_db == pair[1].target_side_to_mid_db
        ):
            accepted.extend(pair)
    return [
        region for region in regions if region.target_side_to_mid_db is None or region in accepted
    ]


def _supported_kind(region: VocalLayerRegion) -> bool:
    if region.kind == "octave":
        return region.semitones in (-12, 12) and not region.modulation_ms
    return (
        region.kind == "double"
        and region.semitones == 0
        and region.delay_ms >= region.modulation_ms
    )


def _valid_regions(regions: Sequence[VocalLayerRegion], duration: float) -> list[VocalLayerRegion]:
    result = []
    for region in regions:
        values = (
            region.start,
            region.end,
            region.gain,
            region.semitones,
            region.delay_ms,
            region.pan,
            region.modulation_ms,
            region.confidence,
        )
        if not all(math.isfinite(value) for value in values) or not _valid_target(region):
            continue
        if not (0 <= region.start < region.end <= duration and 0 < region.gain <= 1):
            continue
        if not (-1 <= region.pan <= 1 and 0 <= region.delay_ms <= 100):
            continue
        if not (0 <= region.modulation_ms <= 20 and 0 < region.confidence <= 1):
            continue
        if _supported_kind(region):
            result.append(region)
    return _paired_targets(result)


def _read_context(audio: sf.SoundFile, start: int, count: int) -> NDArray[np.float64]:
    left = min(count, max(0, -start))
    position = min(audio.frames, max(0, start))
    audio.seek(position)
    samples = audio.read(min(count - left, audio.frames - position), always_2d=True)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    return np.pad(samples, ((left, count - left - len(samples)), (0, 0)))


def _frame_activity(frames: NDArray[np.float64], rate: int) -> NDArray[np.float64]:
    size = frames.shape[-1]
    window = np.hanning(size)
    power = np.mean(abs(np.fft.rfft(frames * window, n=size * 2)) ** 2, axis=1)
    frequencies = np.fft.rfftfreq(size * 2, 1 / rate)
    body = (frequencies >= 80) & (frequencies <= min(3000, rate * 0.45))
    correlation = np.fft.irfft(power * body, n=size * 2)
    window_correlation = np.fft.irfft(abs(np.fft.rfft(window, n=size * 2)) ** 2)
    lags = slice(max(1, round(rate / 1000)), round(rate / 50))
    confidence = correlation[:, lags] / np.maximum(correlation[:, :1], 1e-30)
    confidence *= window_correlation[0] / window_correlation[lags]
    energy = np.sum(power, axis=1) / (size * np.sum(window**2))
    fraction = np.sum(power[:, body], axis=1) / np.maximum(np.sum(power, axis=1), 1e-30)
    return np.column_stack((energy, np.max(confidence, axis=1), fraction))


def _source_activity(
    path: Path, cancel: threading.Event
) -> tuple[NDArray[np.float64], NDArray[np.float64], float, float]:
    peak = 0.0
    with sf.SoundFile(path) as audio:
        hop, size = max(1, round(audio.samplerate * 0.01)), round(audio.samplerate * 0.06)
        centers = np.arange(0, audio.frames, hop)
        values = np.empty((len(centers), 3))
        for first in range(0, len(centers), 32):
            _check_cancel(cancel)
            batch = centers[first : first + 32]
            count = int(batch[-1] - batch[0]) + size
            samples = _read_context(audio, int(batch[0]) - size // 2, count)
            peak = max(peak, float(np.max(abs(samples), initial=0)))
            frames = np.lib.stride_tricks.sliding_window_view(samples, size, axis=0)[::hop]
            values[first : first + len(batch)] = _frame_activity(frames, audio.samplerate)
        floor = max(float(np.percentile(values[:, 0], 80)) * 0.0025, 1e-14)
        eligible = (values[:, 0] > floor) & (values[:, 1] >= 0.7) & (values[:, 2] >= 0.1)
        fade = np.clip((distance_transform_edt(eligible) - 1) / 2, 0, 1)
        return (
            centers / audio.samplerate,
            fade * fade * (3 - 2 * fade),
            float(np.mean(values[:, 0])),
            peak,
        )


def _region_gain(positions: NDArray[np.float64], region: VocalLayerRegion) -> NDArray[np.float64]:
    duration = min(0.035, (region.end - region.start) / 2)
    fade = np.minimum(
        np.clip((positions - region.start) / duration, 0, 1),
        np.clip((region.end - positions) / duration, 0, 1),
    )
    return np.asarray(region.gain * fade * fade * (3 - 2 * fade), dtype=np.float64)


def _pan(samples: NDArray[np.float64], channels: int, pan: float) -> NDArray[np.float64]:
    if channels == 1:
        return np.asarray(
            samples[:, :1] if samples.shape[1] == 1 else samples.mean(axis=1, keepdims=True),
            dtype=np.float64,
        )
    if samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)
    return samples * np.sqrt([(1 - pan) / 2, (1 + pan) / 2])


def _energy(path: Path, cancel: threading.Event) -> float:
    power, count = 0.0, 0
    with sf.SoundFile(path) as audio:
        for samples in audio.blocks(blocksize=_BLOCK, always_2d=True):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            power += float(np.sum(samples**2))
            count += samples.size
    return power / max(1, count)


def _shift_octave(
    renderer: MasterRenderer,
    direct: Path,
    target: Path,
    semitones: float,
    cancel: threading.Event,
) -> None:
    info = sf.info(direct)
    graph = (
        f"[0:a]rubberband=tempo=1:pitch={2 ** (semitones / 12):.12f}:"
        "formant=preserved:pitchq=quality:transients=smooth:channels=together,"
        f"apad,atrim=end_sample={info.frames}[out]"
    )
    renderer._mix(direct, direct, graph, ["-c:a", "pcm_f32le", str(target)], cancel)
    output = sf.info(target)
    if (output.frames, output.samplerate, output.channels) != (
        info.frames,
        info.samplerate,
        info.channels,
    ):
        raise DependencyError("StudioMasterInvalidLayers", "Pitch return changed the audio format")


def _write_octave_return(
    shifted: Path,
    target: Path,
    regions: Sequence[VocalLayerRegion],
    channels: int,
    activity: tuple[NDArray[np.float64], NDArray[np.float64]],
    normalization: float,
    cancel: threading.Event,
) -> None:
    times, weights = activity
    with (
        sf.SoundFile(shifted) as audio,
        _temporary_wave(
            target, samplerate=sf.info(shifted).samplerate, channels=channels
        ) as output,
    ):
        for offset in range(0, audio.frames, _BLOCK):
            _check_cancel(cancel)
            count = min(_BLOCK, audio.frames - offset)
            positions = (offset + np.arange(count)) / audio.samplerate
            wet = np.zeros((count, channels))
            for region in regions:
                delay = round(region.delay_ms * audio.samplerate / 1000)
                samples = _read_context(audio, offset - delay, count)
                source_positions = positions - delay / audio.samplerate
                gate = np.interp(source_positions, times, weights, left=0, right=0)
                boundary = np.minimum(
                    _region_gain(positions, region), _region_gain(source_positions, region)
                )
                gain = boundary * gate * normalization
                wet += _pan(samples, channels, region.pan) * gain[:, None]
            output.write(wet)


def _octave_returns(
    renderer: MasterRenderer,
    direct: Path,
    work: Path,
    regions: Sequence[VocalLayerRegion],
    channels: int,
    activity: tuple[NDArray[np.float64], NDArray[np.float64]],
    source_energy: float,
    cancel: threading.Event,
) -> tuple[list[Path], list[dict[str, object]]]:
    paths, reports = [], []
    for semitones in sorted({region.semitones for region in regions if region.kind == "octave"}):
        shifted, target = work / f"pitch-{semitones}.wav", work / f"octave-{semitones}.wav"
        _shift_octave(renderer, direct, shifted, semitones, cancel)
        energy = _energy(shifted, cancel)
        normalization = float(np.clip(math.sqrt(source_energy / max(energy, 1e-30)), 0.5, 2))
        chosen = [
            region
            for region in regions
            if region.kind == "octave" and region.semitones == semitones
        ]
        _write_octave_return(shifted, target, chosen, channels, activity, normalization, cancel)
        paths.append(target)
        reports.append(
            {
                "semitones": semitones,
                "normalizationGain": normalization,
                "formants": "preserved",
                "regions": len(chosen),
            }
        )
    return paths, reports


def _wet_peak(paths: Sequence[Path], frames: int, channels: int, cancel: threading.Event) -> float:
    peak = 0.0
    with ExitStack() as stack:
        sources = [stack.enter_context(sf.SoundFile(path)) for path in paths]
        for offset in range(0, frames, _BLOCK):
            _check_cancel(cancel)
            count = min(_BLOCK, frames - offset)
            wet = np.zeros((count, channels))
            for source in sources:
                wet += source.read(count, always_2d=True)
            if not np.isfinite(wet).all():
                raise DependencyError(
                    "StudioMasterInvalidLayers", "Vocal return contains invalid samples"
                )
            peak = max(peak, float(np.max(abs(wet), initial=0)))
    return peak


def _sum_returns(
    finished: Path, paths: Sequence[Path], target: Path, gain: float, cancel: threading.Event
) -> None:
    with ExitStack() as stack:
        dry = stack.enter_context(sf.SoundFile(finished))
        returns = [stack.enter_context(sf.SoundFile(path)) for path in paths]
        out = stack.enter_context(
            _temporary_wave(target, samplerate=dry.samplerate, channels=dry.channels)
        )
        for block in dry.blocks(blocksize=_BLOCK, always_2d=True):
            _check_cancel(cancel)
            wet = np.zeros_like(block)
            for source in returns:
                wet += source.read(len(block), always_2d=True)
            out.write(block + gain * wet)


def _render_returns(
    renderer: MasterRenderer,
    direct: Path,
    finished: Path,
    target: Path,
    work: Path,
    regions: Sequence[VocalLayerRegion],
    cancel: threading.Event,
) -> dict[str, object]:
    info = sf.info(finished)
    times, weights, energy, peak = _source_activity(direct, cancel)
    if not weights.any():
        return {"applied": False, "reason": "no-confident-source-activity"}
    paths, octave = _octave_returns(
        renderer, direct, work, regions, info.channels, (times, weights), energy, cancel
    )
    path, double, calibration = _double_return(
        direct, finished, work, regions, info.channels, (times, weights), cancel
    )
    if path is not None:
        paths.append(path)
    wet_peak = _wet_peak(paths, info.frames, info.channels, cancel)
    if wet_peak <= 1e-12:
        return _silent_return(calibration)
    gain = min(1.0, peak / wet_peak)
    mixed = work / "mixed.wav"
    budget = _sum_layer_returns(finished, paths, mixed, gain, calibration, cancel)
    _check_cancel(cancel)
    mixed.replace(target)
    return {
        "applied": True,
        "wetPeakGain": gain,
        "octaveReturns": octave,
        "doubling": double,
        **budget,
    }


def _silent_return(calibration: DoubleCalibration | None) -> dict[str, object]:
    return {
        "applied": False,
        "reason": "silent-layer-return",
        "doublingCalibration": calibration_report(calibration)
        if calibration
        else {"applied": False},
    }


def _double_return(
    direct: Path,
    finished: Path,
    work: Path,
    regions: Sequence[VocalLayerRegion],
    channels: int,
    activity: tuple[NDArray[np.float64], NDArray[np.float64]],
    cancel: threading.Event,
) -> tuple[Path | None, dict[str, object], DoubleCalibration | None]:
    doubles = [region for region in regions if region.kind == "double"]
    if not doubles:
        return None, {"applied": False}, None
    path = work / "double-return.wav"
    report = render_double_layers(
        direct, path, doubles, cancel, channels=channels, activity=activity
    )
    calibration = None
    if any(region.target_side_to_mid_db is not None for region in doubles):
        calibration = calibrate_double_return(
            finished, path, work / "calibrated-double.wav", regions, activity, cancel
        )
        path = calibration.path
    return path, report, calibration


def _sum_layer_returns(
    finished: Path,
    paths: Sequence[Path],
    target: Path,
    gain: float,
    calibration: DoubleCalibration | None,
    cancel: threading.Event,
) -> dict[str, object]:
    if calibration is not None:
        return sum_with_double_budget(finished, paths, target, gain, calibration, cancel)
    _sum_returns(finished, paths, target, gain, cancel)
    return {}


def render_vocal_layers(
    renderer: MasterRenderer,
    direct: Path,
    finished: Path,
    target: Path,
    regions: Sequence[VocalLayerRegion],
    cancel: threading.Event,
) -> tuple[Path, dict[str, object]]:
    """Add approved own-voice returns to a preserved, already finished vocal."""
    _check_cancel(cancel)
    info, source = sf.info(finished), sf.info(direct)
    report: dict[str, object] = {
        "applied": False,
        "method": "parallel-own-voice-layers",
        "dryPreserved": True,
        "source": "own-calibrated-voice",
    }
    if (info.frames, info.samplerate) != (source.frames, source.samplerate):
        return finished, {**report, "reason": "unsynchronized-source"}
    if (
        info.channels not in (1, 2)
        or source.channels not in (1, 2)
        or info.duration < 0.1
        or info.samplerate < 8000
    ):
        return finished, {**report, "reason": "unsupported-audio-layout"}
    if target.resolve() in (direct.resolve(), finished.resolve()):
        return finished, {**report, "reason": "source-path-preserved"}
    selected = _valid_regions(regions, info.duration)
    report.update(
        regions=[asdict(region) for region in selected], skippedRegions=len(regions) - len(selected)
    )
    if not selected:
        return finished, {**report, "reason": "no-supported-regions"}
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".vocal-layers-", dir=target.parent) as directory:
        report.update(
            _render_returns(renderer, direct, finished, target, Path(directory), selected, cancel)
        )
    return target if report["applied"] else finished, report
