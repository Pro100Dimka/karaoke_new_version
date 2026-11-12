from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import math
import threading
import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import (
    MasterRenderer,
    _PROFILE_SECONDS,
    _profile,
    _write_gain_envelope,
)
from backend.recordings.studio_dynamics import _protect_vocal_presence
from backend.recordings.studio_spectrum import _reference_band_targets


def control_vocal_presence(
    voice: Path, backing: Path, cancel: threading.Event
) -> dict[str, object]:
    levels = _profile(voice, cancel)
    music = _profile(backing, cancel, voice_band=True)
    gains, report = _protect_vocal_presence(np.zeros_like(levels), levels, music)
    if np.any(gains):
        target = voice.with_suffix(".presence.wav")
        times = (np.arange(len(gains)) + 0.5) * _PROFILE_SECONDS
        try:
            _write_gain_envelope(voice, target, times, gains, cancel)
            target.replace(voice)
        finally:
            target.unlink(missing_ok=True)
    return {"method": "post-compression-accompaniment-relative-envelope", **report}


def control_vocal_peaks(
    renderer: MasterRenderer, voice: Path, cancel: threading.Event
) -> dict[str, object]:
    levels = _profile(voice, cancel)
    active = levels > max(-60.0, float(np.percentile(levels, 85)) - 22.0)
    if not np.any(active):
        return {"applied": False, "method": "insufficient-active-vocal"}
    threshold_db = float(np.percentile(levels[active], 80))
    threshold = float(np.clip(10 ** (threshold_db / 20), 0.000976, 1.0))
    compressed = voice.with_suffix(".compressed.wav")
    target = voice.with_suffix(".peaks.wav")
    try:
        _compress_voice(renderer, voice, compressed, threshold, cancel)
        measured = _profile(compressed, cancel)
        info = sf.info(voice)
        before, after = (_profile_energy(values, info) for values in (levels, measured))
        gain_db = 10 * math.log10(max(before, 1e-12) / max(after, 1e-12))
        renderer._mix(
            compressed,
            compressed,
            f"[0:a]volume={gain_db:.9f}dB[out]",
            ["-c:a", "pcm_f32le", str(target)],
            cancel,
        )
        target.replace(voice)
        return {
            "applied": True,
            "method": "performance-derived-soft-peak-control",
            "thresholdDb": 20 * math.log10(threshold),
            "ratio": 2.0,
            "attackMs": 5,
            "releaseMs": 120,
            "normalizationGainDb": gain_db,
        }
    finally:
        compressed.unlink(missing_ok=True)
        target.unlink(missing_ok=True)


def _compress_voice(
    renderer: MasterRenderer,
    voice: Path,
    compressed: Path,
    threshold: float,
    cancel: threading.Event,
) -> None:
    renderer._mix(
        voice,
        voice,
        f"[0:a]acompressor=threshold={threshold:.9f}:ratio=2:knee=2.828:"
        "attack=5:release=120:makeup=1:link=maximum:detection=rms[out]",
        ["-c:a", "pcm_f32le", str(compressed)],
        cancel,
    )


def _profile_energy(levels: NDArray[np.float64], info: sf._SoundFileInfo) -> float:
    weights = np.full(len(levels), round(info.samplerate * _PROFILE_SECONDS), dtype=float)
    weights[-1] = info.frames - float(np.sum(weights[:-1]))
    return float(np.dot(10 ** (levels / 10), weights))


def _cohesion_bands(centers: np.ndarray, ratios: np.ndarray) -> list[dict[str, float]]:
    excess = ratios[1:-1] - (ratios[:-2] + ratios[2:]) / 2
    baseline = float(np.median(ratios[1:-1]))
    return [
        {
            "frequencyHz": float(centers[index]),
            "gainDb": -min(float(amount) * 0.5, 1.5),
            "differenceDb": float(amount),
        }
        for index, amount in enumerate(excess, start=1)
        if amount > 3 and ratios[index] > baseline + 1
    ]


def _cohesion_error(
    centers: np.ndarray, ratios: np.ndarray, bands: list[dict[str, float]]
) -> np.ndarray:
    excess = ratios[1:-1] - (ratios[:-2] + ratios[2:]) / 2
    indices = [int(np.argmin(abs(centers[1:-1] - band["frequencyHz"]))) for band in bands]
    return np.asarray(np.abs(excess[indices]), dtype=float)


def apply_mix_tone(
    renderer: MasterRenderer, voice: Path, backing: Path, cancel: threading.Event
) -> dict[str, object]:
    # Paired octave energies retain real vocal harmonics and use the same
    # time windows for both tracks; independent median spectra can hide them.
    edges = np.array([150, 300, 600, 1200, 2400, 4800, 9600], dtype=float)
    centers = np.sqrt(edges[:-1] * edges[1:])
    ratios = _reference_band_targets(voice, backing, centers, cancel)
    if ratios is None:
        return {"applied": False, "method": "insufficient-paired-spectrum"}
    bands = _cohesion_bands(centers, ratios)
    if not bands:
        return {"applied": False, "method": "no-broad-tone-mismatch"}
    filters = [
        f"equalizer=f={band['frequencyHz']:.3f}:t=q:w=0.7:g={band['gainDb']:.6f}" for band in bands
    ]
    target = voice.with_suffix(".tone.wav")
    try:
        renderer._mix(
            voice,
            voice,
            "[0:a]" + ",".join(filters) + "[out]",
            ["-c:a", "pcm_f32le", str(target)],
            cancel,
        )
        candidate = _reference_band_targets(target, backing, centers, cancel)
        before = _cohesion_error(centers, ratios, bands)
        after = _cohesion_error(centers, candidate, bands) if candidate is not None else before
        accepted = bool(np.all(after <= before) and np.sum(after) < np.sum(before))
        if accepted:
            target.replace(voice)
        return {
            "applied": accepted,
            "method": "paired-octave-context-tone",
            "bands": bands,
            "beforeErrorDb": before.tolist(),
            "afterErrorDb": after.tolist(),
        }
    finally:
        target.unlink(missing_ok=True)


@dataclass(slots=True)
class VoicePreparation:
    renderer: MasterRenderer
    user_vocal: Path
    backing: Path
    reference_vocal: Path
    target: Path
    info: sf._SoundFileInfo
    output_channels: int
    cancel: threading.Event
    processing: dict[str, object] = field(init=False)

    def run(self, raw_profile: NDArray[np.float64]) -> dict[str, object]:
        active = raw_profile[raw_profile > max(-80.0, float(np.max(raw_profile)) - 35)]
        if active.size == 0:
            raise DependencyError("StudioMasterSilentTrack", "No audible recorded voice")
        filters, analysis = self.renderer._voice_filters(
            self.user_vocal, raw_profile, self.cancel, self.reference_vocal
        )
        self.processing = {"voiceAnalysis": analysis, "compressionSource": "performance-vocal"}
        filters.extend(
            (
                f"aresample={self.info.samplerate}",
                "apad",
                f"atrim=end_sample={self.info.frames}",
            )
        )
        self.renderer._mix(
            self.user_vocal,
            self.backing,
            "[0:a]" + ",".join(filters) + "[out]",
            ["-ac", str(self.output_channels), "-c:a", "pcm_f32le", str(self.target)],
            self.cancel,
        )
        return self.processing
