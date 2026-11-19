"""Subtract persistent broad vocal coloration before measuring vocal placement."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import math
import threading

import numpy as np
import soundfile as sf
from scipy.ndimage import distance_transform_edt, gaussian_filter1d, uniform_filter1d
from scipy.signal import resample_poly

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _temporary_wave

_RATE = 16000
_SECONDS = 0.12
_SIZE = round(_RATE * _SECONDS)
_TRANSFORM = 2 ** int(np.ceil(np.log2(2 * _SIZE)))


def _read_frame(audio: sf.SoundFile, position: float, cancel: threading.Event) -> np.ndarray | None:
    start = round((position - _SECONDS / 2) * audio.samplerate)
    length = round(_SECONDS * audio.samplerate)
    if start < 0 or start + length > audio.frames:
        return None
    _check_cancel(cancel)
    audio.seek(start)
    samples = audio.read(length, always_2d=True)
    _check_cancel(cancel)
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
    divisor = math.gcd(audio.samplerate, _RATE)
    converted = resample_poly(samples, _RATE // divisor, audio.samplerate // divisor, axis=0)
    return np.asarray(converted[:_SIZE] - np.mean(converted[:_SIZE], axis=0), dtype=float)


def _fundamental(power: np.ndarray, window_correlation: np.ndarray) -> float:
    frequencies = np.fft.rfftfreq(_TRANSFORM, 1 / _RATE)
    correlation = np.fft.irfft(power * (frequencies <= 3500), n=_TRANSFORM)
    lags = np.arange(max(1, round(_RATE / 800)) - 1, round(_RATE / 65) + 2)
    scores = correlation[lags] / max(float(correlation[0]), 1e-30)
    scores *= window_correlation[0] / np.maximum(window_correlation[lags], 1e-20)
    peaks = (scores[1:-1] > scores[:-2]) & (scores[1:-1] >= scores[2:])
    candidates = np.flatnonzero(peaks)
    if not candidates.size:
        return 0.0
    strongest = float(np.max(scores[1:-1][candidates]))
    eligible = candidates[scores[1:-1][candidates] >= max(0.65, strongest * 0.9)]
    # The first independently periodic crest avoids assigning a subharmonic
    # merely because a later multiple has a slightly larger correlation.
    return float(_RATE / lags[1:-1][eligible[0]]) if eligible.size else 0.0


def _frame_profile(
    samples: np.ndarray | None,
    selections: list[np.ndarray],
    window: np.ndarray,
    window_correlation: np.ndarray,
) -> tuple[np.ndarray, float, float]:
    if samples is None:
        return np.zeros(len(selections)), 0.0, 0.0
    energy = float(np.mean(samples**2))
    spectrum = np.mean(
        abs(np.fft.rfft(samples * window[:, None], n=_TRANSFORM, axis=0)) ** 2, axis=1
    )
    bands = np.asarray([np.sum(spectrum[selected]) for selected in selections])
    pitch = _fundamental(spectrum, window_correlation) if energy > 1e-12 else 0.0
    return bands, energy, pitch


def _paired_rows(
    voice: Path,
    reference: Path,
    timing: tuple[np.ndarray, np.ndarray],
    centers: np.ndarray,
    cancel: threading.Event,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    frequencies = np.fft.rfftfreq(_TRANSFORM, 1 / _RATE)
    width = 2 ** (1 / 6)
    selections = [
        (frequencies >= center / width) & (frequencies <= center * width) for center in centers
    ]
    window = np.hanning(_SIZE)
    window_correlation = np.fft.irfft(abs(np.fft.rfft(window, n=_TRANSFORM)) ** 2)
    bands, energy, pitch = [], [], []
    with sf.SoundFile(voice) as singer, sf.SoundFile(reference) as guide:
        for position in np.arange(0.2, singer.frames / singer.samplerate - 0.2, 0.1):
            expected = float(np.interp(position, *timing, left=np.nan, right=np.nan))
            own = _read_frame(singer, float(position), cancel)
            other = _read_frame(guide, expected, cancel) if math.isfinite(expected) else None
            measured = [
                _frame_profile(x, selections, window, window_correlation) for x in (own, other)
            ]
            bands.append([x[0] for x in measured])
            energy.append([x[1] for x in measured])
            pitch.append([x[2] for x in measured])
    _check_cancel(cancel)
    return np.asarray(bands), np.asarray(energy), np.asarray(pitch)


def _voiced_rows(energy: np.ndarray, pitch: np.ndarray) -> np.ndarray:
    if not len(energy):
        return np.zeros(0, dtype=bool)
    audible = energy > np.maximum(np.percentile(energy, 80, axis=0) * 0.01, 1e-12)
    voiced = audible & (pitch > 0)
    difference = abs(12 * np.log2(np.maximum(pitch[:, 0], 1) / np.maximum(pitch[:, 1], 1)))
    matched = np.asarray(np.all(voiced, axis=1) & (difference <= 1), dtype=bool)
    # Require one second of agreement in a two-second neighborhood, preserving
    # the same 50% support locally. A different section cannot veto or authorize
    # correction here. Unmatched samples will keep the original PCM.
    local_support = uniform_filter1d(matched.astype(float), size=20, mode="constant")
    return np.asarray(matched & (local_support >= 0.5), dtype=bool)


def _relative_excess(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    usable = np.all(values > np.sum(values, axis=2, keepdims=True) * 1e-4, axis=1)
    enough = np.count_nonzero(usable, axis=1) >= 8
    difference = 10 * np.log10(np.maximum(values[:, 0], 1e-30) / np.maximum(values[:, 1], 1e-30))
    offsets = np.asarray(
        [
            np.median(row[selected]) if valid else 0.0
            for row, selected, valid in zip(difference, usable, enough)
        ]
    )
    difference -= offsets[:, None]
    return difference, usable & enough[:, None]


def _persistent_excess(difference: np.ndarray, usable: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    coverage = np.mean(usable, axis=0)
    curve = np.zeros(difference.shape[-1])
    supported = coverage >= 0.65
    for index in np.flatnonzero(supported):
        # A lower quartile requires repeated excess, not one loud vowel or
        # an individual coincident harmonic. Reference gain cancels above.
        curve[index] = float(np.percentile(difference[usable[:, index], index], 25))
    return curve, supported


def _local_weights(
    centers: np.ndarray,
    difference: np.ndarray,
    usable: np.ndarray,
    voiced: np.ndarray,
    band: dict[str, float],
) -> np.ndarray:
    nearby = abs(np.log2(centers / band["frequencyHz"])) <= 1 / 3
    desired = np.zeros(len(difference))
    for index, (row, valid) in enumerate(zip(difference, usable)):
        selected = nearby & valid
        if np.count_nonzero(selected) < 3:
            continue
        excess = float(np.median(row[selected]))
        if excess > 3:
            desired[index] = min(excess / -band["gainDb"], 1.0)
    weights = np.zeros(len(voiced))
    weights[voiced] = desired
    distance = distance_transform_edt(np.pad(weights > 0, (1, 1)))[1:-1]
    fade = np.clip((distance - 1) / 2, 0, 1)
    # Fade inside supported intervals only. Smoothing must never spread a
    # correction into a quiet breath, a different note, or an already clean span.
    return np.asarray(gaussian_filter1d(weights, 1.5) * fade**2 * (3 - 2 * fade))


def _broad_band(
    centers: np.ndarray, curve: np.ndarray, supported: np.ndarray
) -> list[dict[str, float]]:
    axis = np.log2(centers)
    smooth = np.zeros_like(curve)
    for index in np.flatnonzero(supported):
        neighbors = supported & (abs(axis - axis[index]) <= 1 / 3)
        if np.count_nonzero(neighbors) >= 3:
            smooth[index] = float(np.median(curve[neighbors]))
    peak = int(np.argmax(smooth))
    if smooth[peak] <= 3:
        return []
    selected = supported & (abs(axis - axis[peak]) <= 1 / 3) & (curve >= smooth[peak] - 1)
    center = float(2 ** np.average(axis[selected], weights=curve[selected]))
    return [
        {
            "frequencyHz": center,
            "gainDb": -min(float(smooth[peak]), 4.5),
            "measuredExcessDb": float(smooth[peak]),
        }
    ]


def _tone_plan(
    voice: Path,
    reference: Path,
    timing: tuple[np.ndarray, np.ndarray],
    cancel: threading.Event,
) -> tuple[list[dict[str, float]], np.ndarray, np.ndarray, dict[str, object]]:
    high = min(6000.0, sf.info(voice).samplerate * 0.45, sf.info(reference).samplerate * 0.45)
    centers = np.geomspace(150, high, 37)
    values, energy, pitch = _paired_rows(voice, reference, timing, centers, cancel)
    voiced = _voiced_rows(energy, pitch)
    times = 0.2 + np.arange(len(voiced)) * 0.1
    weights = np.zeros(len(voiced))
    report: dict[str, object] = {
        "pairedVoicedSeconds": float(np.count_nonzero(voiced) * 0.1),
        "analyzedSeconds": float(len(voiced) * 0.1),
    }
    if not voiced.any():
        return [], times, weights, {**report, "reason": "insufficient-matched-voicing"}
    difference, usable = _relative_excess(values[voiced])
    curve, supported = _persistent_excess(difference, usable)
    bands = _broad_band(centers, curve, supported)
    if bands:
        weights = _local_weights(centers, difference, usable, voiced, bands[0])
    report.update(centersHz=centers.tolist(), relativeExcessDb=curve.tolist())
    report["localBlend"] = {
        "stepSeconds": 0.1,
        "originSeconds": 0.2,
        "weight": weights.round(4).tolist(),
    }
    return bands if weights.any() else [], times, weights, report


def _blend_tone(
    source: Path,
    filtered: Path,
    target: Path,
    times: np.ndarray,
    weights: np.ndarray,
    cancel: threading.Event,
) -> None:
    with (
        sf.SoundFile(source) as dry,
        sf.SoundFile(filtered) as toned,
        _temporary_wave(target, samplerate=dry.samplerate, channels=dry.channels) as output,
    ):
        for samples in dry.blocks(blocksize=65536, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            positions = (dry.tell() - len(samples) + np.arange(len(samples))) / dry.samplerate
            changed = toned.read(len(samples), dtype="float32", always_2d=True)
            _check_cancel(cancel)
            blend = np.interp(positions, times, weights, left=0, right=0)[:, None]
            output.write(samples + (changed - samples) * blend)


def _render_tone(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    bands: list[dict[str, float]],
    times: np.ndarray,
    weights: np.ndarray,
    cancel: threading.Event,
) -> None:
    info = sf.info(source)
    filters = [
        f"equalizer=f={band['frequencyHz']:.9f}:t=q:w=0.7:g={band['gainDb']:.9f}" for band in bands
    ]
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".reference-tone-", dir=target.parent) as temporary:
        filtered, candidate = [Path(temporary) / name for name in ("filtered.wav", "tone.wav")]
        renderer._mix(
            source,
            source,
            "[0:a]" + ",".join(filters) + "[out]",
            ["-c:a", "pcm_f32le", str(filtered)],
            cancel,
        )
        measured = sf.info(filtered)
        if (measured.frames, measured.samplerate, measured.channels) != (
            info.frames,
            info.samplerate,
            info.channels,
        ):
            raise DependencyError(
                "StudioMasterInvalidAudio", "Tone correction changed the audio format"
            )
        _blend_tone(source, filtered, candidate, times, weights, cancel)
        _check_cancel(cancel)
        candidate.replace(target)


def apply_reference_tone(
    renderer: MasterRenderer,
    voice: Path,
    reference: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference_timing: tuple[np.ndarray, np.ndarray] | None,
) -> tuple[Path, dict[str, object]]:
    """Apply one supported broad cut; calibrated placement measures this result."""
    _check_cancel(cancel)
    report: dict[str, object] = {
        "method": "matched-voicing-broad-reference-excess",
        "stage": "before-gain-plan",
        "applied": False,
        "bands": [],
        "maximumCutDb": 4.5,
        "boostDb": 0.0,
    }
    if reference_timing is None:
        return voice, {**report, "reason": "unconfirmed-reference-timeline"}
    if len(reference_timing[0]) < 2 or any(
        not np.isfinite(axis).all() for axis in reference_timing
    ):
        return voice, {**report, "reason": "invalid-reference-timeline"}
    bands, times, weights, evidence = _tone_plan(voice, reference, reference_timing, cancel)
    report.update(evidence)
    _check_cancel(cancel)
    if not bands:
        report.setdefault("reason", "no-supported-broad-excess")
        return voice, report
    _render_tone(renderer, voice, target, bands, times, weights, cancel)
    report.update(applied=True, bands=bands)
    return target, report
