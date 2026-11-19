"""Verify the original mixture before recovering independently published stem gains."""

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import MasterRenderer, _check_cancel


@dataclass(frozen=True, slots=True)
class ReferenceLevelEvidence:
    correction_db: float | None
    report: dict[str, object]


@dataclass(frozen=True, slots=True)
class _Moments:
    gram: np.ndarray
    cross: np.ndarray
    power: np.ndarray


@dataclass(frozen=True, slots=True)
class _Window:
    training: _Moments
    validation: _Moments


def _unavailable(reason: str, *, rejected: bool = False) -> ReferenceLevelEvidence:
    return ReferenceLevelEvidence(
        None,
        {
            "method": "held-out-source-mixture-fit",
            "status": "rejected" if rejected else "unavailable",
            "reason": reason,
        },
    )


def _moments(voice: np.ndarray, backing: np.ndarray, source: np.ndarray) -> _Moments:
    # Separator DC offsets carry no audible balance evidence. Center each
    # channel independently so a quiet held-out tail still tests its AC content.
    voice, backing, source = (
        samples - np.mean(samples, axis=0, keepdims=True) for samples in (voice, backing, source)
    )
    design = np.stack((voice, backing), axis=-1)
    count = len(source)
    return _Moments(
        np.einsum("tci,tcj->cij", design, design) / count,
        np.einsum("tci,tc->ci", design, source) / count,
        np.mean(source**2, axis=0),
    )


def _coefficients(moments: _Moments) -> np.ndarray | None:
    gram, cross = np.mean(moments.gram, axis=0), np.mean(moments.cross, axis=0)
    scale = np.sqrt(np.diag(gram))
    if np.min(scale) < 1e-7 or np.mean(moments.power) < 1e-12:
        return None
    normalized = gram / np.outer(scale, scale)
    eigenvalues = np.linalg.eigvalsh(normalized)
    if eigenvalues[0] <= 0 or eigenvalues[-1] / eigenvalues[0] > 100:
        return None
    coefficients = np.linalg.solve(normalized, cross / scale) / scale
    if not np.isfinite(coefficients).all() or np.min(coefficients) <= 0:
        return None
    return np.asarray(coefficients, dtype=float)


def _residual(moments: _Moments, coefficients: np.ndarray) -> np.ndarray:
    predicted = np.einsum("i,cij,j->c", coefficients, moments.gram, coefficients)
    error = moments.power - 2 * (moments.cross @ coefficients) + predicted
    return np.asarray(np.maximum(error, 0), dtype=float)


def _eligible(moments: _Moments, coefficients: np.ndarray) -> bool:
    power = float(np.mean(moments.power))
    error = float(np.mean(_residual(moments, coefficients)))
    components = coefficients**2 * np.diag(np.mean(moments.gram, axis=0))
    # A low total error alone cannot identify a nearly absent vocal stem.
    # Each recovered component must independently stand above the residual.
    return bool(np.min(components) > max(power * 0.01, error * 20, 1e-12) and error < power * 0.005)


def _read_windows(
    voice: Path, backing: Path, source: Path, cancel: threading.Event
) -> list[_Window] | None:
    windows = []
    with sf.SoundFile(voice) as vocal, sf.SoundFile(backing) as music, sf.SoundFile(source) as mix:
        files = vocal, music, mix
        if len({(item.samplerate, item.channels) for item in files}) != 1:
            return None
        if vocal.channels not in (1, 2) or vocal.frames != music.frames:
            return None
        rate = vocal.samplerate
        if abs(vocal.frames - mix.frames) > round(rate * 0.02):
            return None
        duration = min(item.frames for item in files) / rate
        count = min(12, int(duration // 2))
        if count < 3:
            return None
        for start in np.linspace(0, duration - 2, count):
            _check_cancel(cancel)
            for item in files:
                item.seek(round(float(start) * rate))
            blocks = [item.read(rate * 2, dtype="float64", always_2d=True) for item in files]
            _check_cancel(cancel)
            if any(len(block) != rate * 2 or not np.isfinite(block).all() for block in blocks):
                return None
            windows.append(
                _Window(
                    _moments(*(block[:rate] for block in blocks)),
                    _moments(*(block[rate:] for block in blocks)),
                )
            )
    return windows


def _validation_report(
    windows: list[_Window], coefficients: np.ndarray, active_power: np.ndarray
) -> dict[str, object] | None:
    errors = []
    # Keep the existing 1% error ceiling, with a floor 40 dB below observed
    # active-source power. Quiet-tail residual is therefore still bounded to
    # 60 dB below active source; no silent window or channel is omitted.
    floor = np.maximum(active_power * 1e-4, 1e-12)
    for window in windows:
        evidence = window.validation
        # Source silence must also agree: ignoring it would hide a wrong source
        # section or channel while the fitted stems still predict audible sound.
        errors.extend(
            (_residual(evidence, coefficients) / np.maximum(evidence.power, floor)).tolist()
        )
    if not errors or max(errors) > 0.01 or float(np.mean(errors)) > 0.0025:
        return None
    return {
        "heldOutMaxResidualDb": float(10 * np.log10(max(max(errors), 1e-20))),
        "heldOutMeanResidualDb": float(10 * np.log10(max(float(np.mean(errors)), 1e-20))),
        "validatedWindows": len(windows),
        "maxQuietResidualRelativeToActiveDb": -60.0,
    }


def _combine(moments: list[_Moments]) -> _Moments:
    return _Moments(
        np.mean([item.gram for item in moments], axis=0),
        np.mean([item.cross for item in moments], axis=0),
        np.mean([item.power for item in moments], axis=0),
    )


def _recover(windows: list[_Window], cancel: threading.Event) -> ReferenceLevelEvidence:
    eligible, ratios = [], []
    for window in windows:
        _check_cancel(cancel)
        coefficients = _coefficients(window.training)
        if coefficients is None or not _eligible(window.training, coefficients):
            continue
        eligible.append(window.training)
        ratios.append(float(20 * np.log10(coefficients[0] / coefficients[1])))
    if len(eligible) < 3:
        return _unavailable("insufficient-independent-stem-evidence", rejected=True)
    spread = float(np.max(np.abs(np.asarray(ratios) - np.median(ratios))))
    if spread > 0.5:
        return _unavailable("inconsistent-stem-gain-ratio", rejected=True)
    combined = _combine(eligible)
    coefficients = _coefficients(combined)
    active_power = np.median([item.power for item in eligible], axis=0)
    validation = (
        None if coefficients is None else _validation_report(windows, coefficients, active_power)
    )
    _check_cancel(cancel)
    if coefficients is None or validation is None:
        return _unavailable("source-mixture-validation-failed", rejected=True)
    correction = float(20 * np.log10(coefficients[0] / coefficients[1]))
    return ReferenceLevelEvidence(
        correction,
        {
            "method": "held-out-source-mixture-fit",
            "status": "verified",
            "signalComponent": "per-channel-ac",
            "correctionDb": correction,
            "eligibleWindows": len(eligible),
            "ratioMaxDeviationDb": spread,
            "vocalCoefficient": float(coefficients[0]),
            "backingCoefficient": float(coefficients[1]),
            **validation,
        },
    )


def analyze_reference_level(
    renderer: MasterRenderer,
    source_mix: Path | None,
    reference_vocal: Path,
    reference_backing: Path,
    work: Path,
    cancel: threading.Event,
) -> ReferenceLevelEvidence:
    _check_cancel(cancel)
    if source_mix is None or not source_mix.is_file():
        return _unavailable("source-mix-unavailable")
    try:
        rate = sf.info(reference_vocal).samplerate
        decoded = work / "reference-level-source.wav"
        renderer._mix(
            source_mix,
            source_mix,
            f"[0:a]aresample={rate}[out]",
            ["-c:a", "pcm_f32le", str(decoded)],
            cancel,
        )
        _check_cancel(cancel)
        windows = _read_windows(reference_vocal, reference_backing, decoded, cancel)
    except (OSError, sf.LibsndfileError, DependencyError):
        _check_cancel(cancel)
        return _unavailable("source-audio-unreadable")
    if windows is None:
        return _unavailable("incompatible-source-format-or-timeline", rejected=True)
    return _recover(windows, cancel)
