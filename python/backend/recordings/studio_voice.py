from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import math
import threading
import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_dynamics import _reference_compression, _reference_tone


def _cohesion_bands(
    measured: tuple[float, np.ndarray, np.ndarray],
    reference: tuple[float, np.ndarray, np.ndarray],
) -> list[dict[str, float]]:
    centers, tone = measured[1:]
    excess = tone - np.interp(centers, reference[1], reference[2])
    bands = []
    # Broad corrections preserve the singer's formants; gains come from the song.
    for low, high, boost, cut in ((300, 600, 0, 1.5), (1200, 2400, 1, 1.5), (4800, 9600, 0, 3)):
        selected = (centers >= low) & (centers < high)
        values = excess[selected]
        if len(values) < 4:
            continue
        difference = float(np.median(values))
        if abs(difference) < 1 or np.mean(np.sign(values) == np.sign(difference)) < 0.75:
            continue
        gain = float(np.clip(-difference * 0.5, -cut, boost))
        if not gain:
            continue
        frequency = float(np.exp(np.average(np.log(centers[selected]), weights=np.abs(values))))
        bands.append(
            {
                "lowHz": low,
                "highHz": high,
                "frequencyHz": frequency,
                "gainDb": gain,
                "differenceDb": difference,
            }
        )
    return bands


def _cohesion_error(
    measured: tuple[float, np.ndarray, np.ndarray],
    reference: tuple[float, np.ndarray, np.ndarray],
    bands: list[dict[str, float]],
) -> np.ndarray:
    centers, tone = measured[1:]
    excess = tone - np.interp(centers, reference[1], reference[2])
    return np.array(
        [
            abs(float(np.median(excess[(centers >= band["lowHz"]) & (centers < band["highHz"])])))
            for band in bands
        ]
    )


def apply_reference_tone(
    renderer: MasterRenderer, voice: Path, reference: Path, cancel: threading.Event
) -> dict[str, object]:
    measured, expected = _reference_tone(voice, cancel), _reference_tone(reference, cancel)
    if measured is None or expected is None:
        return {"applied": False, "method": "insufficient-tone-evidence"}
    bands = _cohesion_bands(measured, expected)
    if not bands:
        return {"applied": False, "method": "no-broad-tone-mismatch"}
    filters = [
        (
            f"highshelf=f={band['lowHz']:.3f}"
            if band["lowHz"] >= 4800
            else f"equalizer=f={band['frequencyHz']:.3f}"
        )
        + f":t=q:w=0.7:g={band['gainDb']:.6f}"
        for band in bands
    ]
    target = voice.with_suffix(".tone.wav")
    try:
        graph = "[0:a]" + ",".join(filters) + "[out]"
        output = ["-c:a", "pcm_f32le", str(target)]
        renderer._mix(voice, voice, graph, output, cancel)
        candidate = _reference_tone(target, cancel)
        before = _cohesion_error(measured, expected, bands)
        after = _cohesion_error(candidate, expected, bands) if candidate else before
        accepted = bool(np.all(after <= before) and np.sum(after) < np.sum(before))
        if accepted:
            target.replace(voice)
        return {
            "applied": accepted,
            "method": "post-space-reference-broad-tone",
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

    def run(
        self, raw_profile: NDArray[np.float64], reference_levels: NDArray[np.float64]
    ) -> dict[str, object]:
        active = raw_profile[raw_profile > max(-80.0, float(np.max(raw_profile)) - 35)]
        if active.size == 0:
            raise DependencyError("StudioMasterSilentTrack", "No audible recorded voice")
        dynamics = _reference_compression(raw_profile, reference_levels)
        ratio = float(dynamics["ratio"])
        threshold = float(np.clip(10 ** (float(dynamics["thresholdDb"]) / 20), 0.001, 1))
        self.processing = {"referenceCompression": dynamics}
        filters, analysis = self.renderer._voice_filters(
            self.user_vocal, raw_profile, self.cancel, self.reference_vocal
        )
        self.processing.update(
            compressorRatio=ratio,
            compressorThresholdDb=20 * math.log10(threshold),
            voiceAnalysis=analysis,
            compressorMix=1.0,
        )
        if ratio > 1.01:
            filters.append(
                f"acompressor=threshold={threshold:.9f}:ratio={ratio:.6f}:"
                f"attack={float(dynamics['attackMs']):.3f}:release={float(dynamics['releaseMs']):.3f}:"
                "makeup=1:mix=1:link=maximum:detection=rms"
            )
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
