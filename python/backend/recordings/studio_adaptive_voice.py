"""Adaptive vocal preparation and the ordered, independently measured insert chain."""

from __future__ import annotations

from pathlib import Path
import threading
from tempfile import TemporaryDirectory

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_voice import render_voice_filters as _filter
from backend.recordings.studio_adaptive_features import VoiceFeatures, analyze_voice, level_summary
from backend.recordings.studio_adaptive_dynamics import (
    compressor_plan,
    deess_voice,
    saturate_voice,
    write_prepared,
)


def _reference(path: Path | None, cancel: threading.Event) -> VoiceFeatures | None:
    if path is None:
        return None
    measured = analyze_voice(path, cancel)
    return measured if measured.active_seconds >= 0.3 else None


def prepare_voice(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference: Path | None = None,
) -> dict[str, object]:
    del renderer  # This stage is sample-preserving gain automation, without a subprocess.
    measured = analyze_voice(source, cancel)
    origin = _reference(reference, cancel)
    report = write_prepared(source, target, measured, origin, cancel)
    report["before"] = level_summary(measured)
    report["after"] = level_summary(analyze_voice(target, cancel))
    return report


def _subtractive_plan(
    voice: VoiceFeatures, reference: VoiceFeatures | None
) -> tuple[list[str], dict[str, object]]:
    cutoff = float(np.clip(voice.low_edge_hz * 0.45, 18, 85))
    filters = [f"highpass=f={cutoff:.6f}:p=2"]
    resonances = _resonance_cuts(voice, reference) if reference is not None else []
    filters.extend(
        f"equalizer=f={b['frequencyHz']:.6f}:t=q:w=1.5:g={b['gainDb']:.6f}" for b in resonances
    )
    return filters, {
        "highpassHz": cutoff,
        "measuredLowEdgeHz": voice.low_edge_hz,
        "resonances": resonances,
        "resonanceDecision": "supported-broad-reference-excess"
        if resonances
        else "no-supported-reference-excess",
    }


def _resonance_cuts(voice: VoiceFeatures, reference: VoiceFeatures) -> list[dict[str, float]]:
    # Strong harmonics are musical information. Require a populated broad spectrum
    # and repeated broad excess before making any resonance-like correction.
    energetic_floor = float(np.max(voice.spectrum_db)) - 24
    populated = (
        (voice.frequencies >= 150)
        & (voice.frequencies < 4000)
        & (voice.spectrum_db > energetic_floor)
    )
    if len(voice.spectral_frames) < 12 or np.count_nonzero(populated) < 20:
        return []
    expected = np.interp(voice.frequencies, reference.frequencies, reference.spectrum_db)
    difference = voice.spectrum_db - expected
    middle = (voice.frequencies >= 180) & (voice.frequencies <= 4500)
    difference -= float(np.median(difference[middle]))
    return _supported_cuts(voice, difference, energetic_floor)


def _supported_cuts(
    voice: VoiceFeatures, difference: np.ndarray, energetic_floor: float
) -> list[dict[str, float]]:
    smooth = gaussian_filter1d(difference, 2)
    candidates, _ = find_peaks(smooth, height=4.5, prominence=2.0, distance=12)
    valid = [int(i) for i in candidates if 180 <= voice.frequencies[i] <= 1000]
    resonances = []
    for index in sorted(valid, key=lambda i: smooth[i], reverse=True)[:2]:
        if voice.spectrum_db[index] < energetic_floor:
            continue
        neighbors = abs(np.log2(voice.frequencies / voice.frequencies[index])) < 0.25
        if np.count_nonzero(neighbors & (difference > 3.5)) < 4:
            continue
        reduction = float(np.clip((smooth[index] - 2) * 0.45, 0, 2.5))
        resonances.append(
            {
                "frequencyHz": float(voice.frequencies[index]),
                "gainDb": -reduction,
                "referenceExcessDb": float(smooth[index]),
                "q": 1.5,
            }
        )
    return resonances


def _color_plan(
    voice: VoiceFeatures, reference: VoiceFeatures | None
) -> tuple[list[str], dict[str, object]]:
    bands: list[dict[str, float]] = []
    filters: list[str] = []
    if reference is None or voice.active_seconds < 0.3:
        return filters, {"bands": bands, "reason": "no-supported-reference-tone"}
    actual = np.median(voice.bands_db[voice.active], axis=0)
    expected = np.median(reference.bands_db[reference.active], axis=0)
    for band, frequency, kind in ((4, 2800.0, "equalizer"), (7, 11000.0, "treble")):
        if frequency >= min(voice.rate, reference.rate) * 0.4:
            continue
        difference = (expected[band] - expected[3]) - (actual[band] - actual[3])
        # Avoid lifting missing bandwidth, room hiss, and separated-stem artefacts.
        if actual[band] < max(-85, voice.noise_floor_db + 8) or not 2 < difference < 18:
            continue
        gain = float(np.clip((difference - 1) * 0.25, 0, 1.5))
        filters.append(f"{kind}=f={frequency:.6f}:t=q:w=0.7:g={gain:.6f}")
        bands.append(
            {"frequencyHz": frequency, "gainDb": gain, "referenceDifferenceDb": float(difference)}
        )
    return filters, {
        "bands": bands,
        "reason": "bounded-broad-reference-tone",
        "maxBoostPerBandDb": 1.5,
    }


def _compress(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    features: VoiceFeatures,
    reference: VoiceFeatures | None,
    cancel: threading.Event,
    *,
    fast: bool,
) -> tuple[VoiceFeatures, dict[str, object]]:
    graph, report = compressor_plan(features, fast=fast, reference=reference)
    _filter(renderer, source, target, [graph] if graph else [], cancel)
    after = analyze_voice(target, cancel)
    reduction = features.rms_db - after.rms_db
    selected = reduction[features.active]
    report["measuredMedianReductionDb"] = float(np.median(selected)) if selected.size else 0.0
    report["measuredP95ReductionDb"] = float(np.percentile(selected, 95)) if selected.size else 0.0
    report["before"] = level_summary(features)
    report["after"] = level_summary(after)
    return after, report


def process_voice(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference: Path | None = None,
) -> dict[str, object]:
    measured = analyze_voice(source, cancel)
    origin = _reference(reference, cancel)
    with TemporaryDirectory(prefix=".vocal-inserts-", dir=target.parent) as directory:
        report = _insert_chain(renderer, source, target, Path(directory), measured, origin, cancel)
    report["order"] = [
        "subtractive-eq",
        "peak-compressor",
        "leveling-compressor",
        "deesser",
        "color-eq",
        "saturation",
    ]
    report["before"] = level_summary(measured)
    report["after"] = level_summary(analyze_voice(target, cancel))
    return report


def _insert_chain(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    work: Path,
    measured: VoiceFeatures,
    origin: VoiceFeatures | None,
    cancel: threading.Event,
) -> dict[str, object]:
    report: dict[str, object] = {}
    subtractive, report["subtractiveEq"] = _subtractive_plan(measured, origin)
    equalized = work / "subtractive.wav"
    _filter(renderer, source, equalized, subtractive, cancel)
    measured = analyze_voice(equalized, cancel)
    peak, leveling = work / "peak.wav", work / "leveling.wav"
    measured, report["peakCompressor"] = _compress(
        renderer, equalized, peak, measured, origin, cancel, fast=True
    )
    # Plan leveling from the actual first compressor output.
    measured, report["levelingCompressor"] = _compress(
        renderer, peak, leveling, measured, origin, cancel, fast=False
    )
    deessed = work / "deessed.wav"
    report["deesser"] = deess_voice(leveling, deessed, cancel, features=measured)
    measured = analyze_voice(deessed, cancel)
    coloring, report["colorEq"] = _color_plan(measured, origin)
    colored = work / "colored.wav"
    _filter(renderer, deessed, colored, coloring, cancel)
    measured = analyze_voice(colored, cancel)
    report["saturation"] = saturate_voice(colored, target, work, cancel, measured)
    return report
