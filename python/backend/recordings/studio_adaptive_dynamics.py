"""Phrase gain, gentle pause editing, and phase-coherent split-band de-essing."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
import shutil
import threading

import numpy as np
from scipy.ndimage import gaussian_filter1d, maximum_filter1d, median_filter
from scipy.signal import istft, resample_poly, stft
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel, _temporary_wave, _write_gain_envelope
from backend.recordings.studio_adaptive_features import (
    FloatArray,
    FrameFeatures,
    analyze_frames,
    protected_activity,
    regions,
)
from backend.recordings.studio_parallel import ordered_map


@dataclass(frozen=True, slots=True)
class _ContextBlock:
    samples: FloatArray
    begin: int
    count: int


def _context_blocks(
    audio: sf.SoundFile,
    blocksize: int,
    overlap: int,
    cancel: threading.Event,
) -> Iterator[_ContextBlock]:
    for offset in range(0, audio.frames, blocksize):
        _check_cancel(cancel)
        count = min(blocksize, audio.frames - offset)
        start, end = max(0, offset - overlap), min(audio.frames, offset + count + overlap)
        audio.seek(start)
        samples = audio.read(end - start, dtype="float64", always_2d=True)
        yield _ContextBlock(samples, offset - start, count)


def _protected_frames(features: FrameFeatures, reference: FrameFeatures | None) -> np.ndarray:
    protected = protected_activity(features, 0.35)
    if reference is not None:
        expected = np.interp(
            features.times,
            reference.times,
            protected_activity(reference).astype(float),
            left=0,
            right=0,
        )
        protected |= expected > 0
    return protected


def _clip_gain(features: FrameFeatures, protected: np.ndarray) -> FloatArray:
    # Silence is not the desired level of a short word. Fill only the analysis
    # context across gaps; the gain remains disabled in the actual pause.
    evidence = (
        np.interp(features.times, features.times[features.active], features.rms_db[features.active])
        if features.active.any()
        else features.rms_db
    )
    local = median_filter(evidence, size=5, mode="nearest")
    context = median_filter(
        evidence, size=max(3, round(1.5 / features.step) // 2 * 2 + 1), mode="nearest"
    )
    gain = np.clip((context - local) * 0.55, -6, 6)
    # A quiet song is not a quiet *word*. Local deviations preserve broad dynamics.
    gain[~features.active] = 0
    gain = gaussian_filter1d(gain, max(1, 0.06 / features.step), mode="nearest")
    gain[~protected] = 0
    return np.asarray(gain, dtype=np.float64)


def _cleanup_report(features: FrameFeatures, cleanup: FloatArray) -> dict[str, object]:
    return {
        "method": "confirmed-pause-expansion-with-fades",
        "noiseFloorDbfs": features.noise_floor_db,
        "noiseEvidence": features.noise_confident,
        "maxReductionDb": float(-np.min(cleanup)),
        "attenuatedSeconds": float(np.count_nonzero(cleanup < -1) * features.step),
        "removedSeconds": 0,
        "protectedTailSeconds": 0.35,
    }


def _clip_report(features: FrameFeatures, gain: FloatArray) -> dict[str, object]:
    phrase_mask = (
        maximum_filter1d(
            features.active.astype(np.int8), size=max(1, round(0.15 / features.step)) * 2 + 1
        )
        > 0
    )
    return {
        "method": "local-word-deviation-from-phrase",
        "phraseCount": len(regions(phrase_mask)),
        "maxBoostDb": float(max(0, np.max(gain))),
        "maxCutDb": float(max(0, -np.min(gain))),
        "analysisStepMs": features.step * 1000,
        "contextSeconds": 1.5,
        "automation": [
            {"seconds": round(float(t), 3), "gainDb": round(float(g), 3)}
            for t, g in zip(features.times[::25], gain[::25])
        ],
    }


def preparation_gain(
    features: FrameFeatures, reference: FrameFeatures | None
) -> tuple[FloatArray, dict[str, object]]:
    protected = _protected_frames(features, reference)
    gap = (~protected) & (features.rms_db < features.noise_floor_db + 2.5)
    cleanup = (
        gaussian_filter1d(gap.astype(float), max(1, 0.05 / features.step)) * -6
        if features.noise_confident
        else np.zeros_like(features.rms_db)
    )
    gain = _clip_gain(features, protected)
    return gain + cleanup, {
        "order": ["pause-cleanup", "clip-gain"],
        "cleanup": _cleanup_report(features, cleanup),
        "clipGain": _clip_report(features, gain),
    }


def write_prepared(
    source: Path,
    target: Path,
    features: FrameFeatures,
    reference: FrameFeatures | None,
    cancel: threading.Event,
) -> dict[str, object]:
    gain, report = preparation_gain(features, reference)
    _write_gain_envelope(source, target, features.times, gain, cancel)
    return report


def _reference_span(reference: FrameFeatures | None) -> float:
    if reference is None or np.count_nonzero(reference.active) < 10:
        return 7.0
    ref = reference.rms_db[reference.active]
    return float(np.clip(np.percentile(ref, 90) - np.percentile(ref, 20), 5, 12))


def _compressor_levels(
    values: FloatArray, fast: bool, reference_span: float
) -> tuple[float, float, float, float]:
    p20, p50, p90, p99 = np.percentile(values, [20, 50, 90, 99])
    excess = p99 - p50 - 3 if fast else p90 - p20 - reference_span
    reduction = float(np.clip(excess * (0.55 if fast else 0.4), 0, 4 if fast else 3))
    ratio = (
        float(np.clip(1.6 + reduction * 0.5, 1.6, 4))
        if fast
        else float(np.clip(1.3 + reduction * 0.35, 1.3, 2.5))
    )
    ceiling = p99 if fast else p90
    threshold = float(np.clip(ceiling - reduction / (1 - 1 / ratio), -58, -0.5))
    return threshold, ratio, reduction, float(p90 - p20)


def _compressor_timing(features: FrameFeatures, fast: bool) -> tuple[float, float]:
    # Shorter syllables recover sooner; timing remains within audible-pumping guardrails.
    runs = [b - a for a, b in regions(features.active)]
    phrase_seconds = float(np.median(runs)) * features.step if runs else 1
    attack = 2.0 if fast else float(np.clip(phrase_seconds * 12, 12, 35))
    release = float(
        np.clip(phrase_seconds * (30 if fast else 120), 45 if fast else 120, 90 if fast else 300)
    )
    return attack, release


def compressor_plan(
    features: FrameFeatures, *, fast: bool, reference: FrameFeatures | None = None
) -> tuple[str | None, dict[str, object]]:
    values = (features.peak_db if fast else features.rms_db)[features.active]
    if values.size < 3:
        return None, {"applied": False, "reason": "insufficient-dynamics-evidence"}
    reference_span = _reference_span(reference)
    threshold, ratio, reduction, span = _compressor_levels(values, fast, reference_span)
    attack, release = _compressor_timing(features, fast)
    report: dict[str, object] = {
        "applied": reduction >= 0.3,
        "detector": "peak" if fast else "rms",
        "thresholdDbfs": threshold,
        "ratio": ratio,
        "attackMs": attack,
        "releaseMs": release,
        "plannedUpperReductionDb": reduction,
        "referenceDynamicSpanDb": reference_span,
        "makeupDb": 0.0,
        "inputSpanDb": span,
        "linkedChannels": True,
    }
    if reduction < 0.3:
        report["reason"] = "dynamics-already-controlled"
        return None, report
    graph = (
        f"acompressor=threshold={10 ** (threshold / 20):.9f}:ratio={ratio:.6f}:"
        f"attack={attack:.6f}:release={release:.6f}:knee=1.5:makeup=1:"
        f"link=maximum:detection={'peak' if fast else 'rms'}"
    )
    return graph, report


def _sibilance_curve(features: FrameFeatures) -> tuple[FloatArray, float]:
    body = np.sum(10 ** (features.bands_db[:, 2:5] / 10), axis=1)
    high = np.sum(10 ** (features.bands_db[:, 5:7] / 10), axis=1)
    ratio = 10 * np.log10(np.maximum(high, 1e-12) / np.maximum(body, 1e-12))
    active = features.active & (features.rms_db > -85)
    threshold = max(-14.0, float(np.percentile(ratio[active], 30)) + 9) if active.any() else 10.0
    # Sustained brightness belongs to the phrase's timbre. React to a transient
    # excess above both the whole-take and local spectral baselines.
    local = median_filter(
        ratio, size=max(3, round(1.5 / features.step) // 2 * 2 + 1), mode="nearest"
    )
    threshold_curve = np.maximum(threshold, local + 6)
    reduction = np.clip((ratio - threshold_curve) * 0.6, 0, 6)
    # A quiet breathy word can be mostly high-frequency energy without being
    # piercing. Relative salience keeps it out of the loud-sibilant detector.
    body_db = 10 * np.log10(np.maximum(body, 1e-12))
    high_db = 10 * np.log10(np.maximum(high, 1e-12))
    salient_floor = float(np.percentile(body_db[active], 70)) - 12 if active.any() else 0.0
    reduction *= np.clip((high_db - salient_floor) / 6, 0, 1)
    reduction[~active] = 0
    reduction = maximum_filter1d(reduction, size=3, mode="nearest")
    reduction = gaussian_filter1d(reduction, 1, mode="nearest")
    return np.asarray(reduction, dtype=np.float64), threshold


def _spectral_attenuation(
    source: Path,
    target: Path,
    features: FrameFeatures,
    reduction: FloatArray,
    low: float,
    high: float,
    cancel: threading.Event,
) -> None:
    # Overlapped analysis of neighbouring blocks keeps each sample on the original
    # timeline. All channels share the same gain; no crossover phase mismatch.
    nfft = 1024 if features.rate >= 24000 else 512
    blocksize = nfft * 64
    with (
        sf.SoundFile(source) as audio,
        _temporary_wave(target, samplerate=audio.samplerate, channels=audio.channels) as output,
    ):
        for offset in range(0, audio.frames, blocksize):
            _check_cancel(cancel)
            count = min(blocksize, audio.frames - offset)
            start, end = max(0, offset - nfft), min(audio.frames, offset + count + nfft)
            audio.seek(start)
            samples = audio.read(end - start, dtype="float64", always_2d=True)
            if len(samples) < nfft:
                samples = np.pad(samples, ((0, nfft - len(samples)), (0, 0)))
            restored = _deess_block(samples, start, features, reduction, (low, high), nfft)
            output.write(restored[:, offset - start : offset - start + count].T)


def _deess_block(
    samples: FloatArray,
    start: int,
    features: FrameFeatures,
    reduction: FloatArray,
    band: tuple[float, float],
    nfft: int,
) -> FloatArray:
    frequencies, time, spectrum = stft(
        samples, fs=features.rate, nperseg=nfft, noverlap=nfft // 2, axis=0
    )
    curve = np.interp(time + start / features.rate, features.times, reduction)
    low, high = band
    width = min(1000, (high - low) / 3)
    strength = np.clip((frequencies - (low - width)) / width, 0, 1)
    strength *= np.clip(((high + width) - frequencies) / width, 0, 1)
    strength = (1 - np.cos(np.pi * strength)) / 2
    gain = 10 ** (-strength[:, None] * curve[None, :] / 20)
    _, restored = istft(
        spectrum * gain[:, None, :],
        fs=features.rate,
        nperseg=nfft,
        noverlap=nfft // 2,
        freq_axis=0,
        time_axis=-1,
    )
    return np.asarray(restored, dtype=np.float64)


def deess_voice(
    source: Path, target: Path, cancel: threading.Event, *, features: FrameFeatures | None = None
) -> dict[str, object]:
    measured = features or analyze_frames(source, cancel)
    reduction, threshold = _sibilance_curve(measured)
    low, high = 4500.0, min(10000.0, measured.rate * 0.46)
    applied = bool(high > low + 700 and np.max(reduction) >= 0.3)
    if applied:
        _spectral_attenuation(source, target, measured, reduction, low, high, cancel)
    else:
        _check_cancel(cancel)
        shutil.copyfile(source, target)
    return {
        "applied": applied,
        "method": "linked-spectral-split-band",
        "lowHz": low,
        "highHz": high,
        "thresholdRelativeDb": threshold,
        "maxReductionDb": float(np.max(reduction)) if applied else 0.0,
        "affectedSeconds": float(np.count_nonzero(reduction > 0.5) * measured.step)
        if applied
        else 0.0,
    }


def _write_saturation(
    source: Path,
    temporary: Path,
    scale: float,
    cancel: threading.Event,
) -> tuple[float, float]:
    before_energy, after_energy = 0.0, 0.0
    with (
        sf.SoundFile(source) as audio,
        _temporary_wave(temporary, samplerate=audio.samplerate, channels=audio.channels) as output,
    ):

        def saturate(block: _ContextBlock) -> tuple[FloatArray, float, float]:
            _check_cancel(cancel)
            return _saturation_block(block, scale)

        blocks = _context_blocks(audio, 65536, 96, cancel)
        for colored, before, after in ordered_map(saturate, blocks):
            _check_cancel(cancel)
            # Preserve the original block order of both scalar energy accumulations.
            before_energy += before
            after_energy += after
            output.write(colored)
    return before_energy, after_energy


def _saturation_block(block: _ContextBlock, scale: float) -> tuple[FloatArray, float, float]:
    # Zero-phase polyphase resampling with overlap retains sample alignment.
    expanded = resample_poly(block.samples, 4, 1, axis=0)
    wet = resample_poly(np.tanh(expanded * scale) / scale, 1, 4, axis=0)
    dry = block.samples[block.begin : block.begin + block.count]
    colored = dry + 0.06 * (wet[block.begin : block.begin + block.count] - dry)
    return colored, float(np.sum(dry**2)), float(np.sum(colored**2))


def saturate_voice(
    source: Path, target: Path, work: Path, cancel: threading.Event, features: FrameFeatures
) -> dict[str, object]:
    active_peaks = features.peak_db[features.active]
    if active_peaks.size == 0:
        _check_cancel(cancel)
        shutil.copyfile(source, target)
        return {"applied": False, "reason": "no-active-vocal"}
    scale = float(np.clip(0.6 / 10 ** (float(np.percentile(active_peaks, 95)) / 20), 0.25, 64))
    temporary = work / "saturation-uncompensated.wav"
    before_energy, after_energy = _write_saturation(source, temporary, scale, cancel)
    gain = float(
        np.clip(10 * np.log10(max(before_energy, 1e-20) / max(after_energy, 1e-20)), -1, 1)
    )
    _write_gain_envelope(temporary, target, np.asarray([0.0]), np.asarray([gain]), cancel)
    return {
        "applied": True,
        "method": "parallel-tanh-oversampled",
        "wetFraction": 0.06,
        "drive": scale,
        "oversampling": 4,
        "gainCompensationDb": gain,
    }
