"""Conservative constant recording-delay correction from agreeing phrase onsets."""

from __future__ import annotations

from pathlib import Path
import shutil
import threading

import numpy as np
from scipy.ndimage import gaussian_filter1d
import soundfile as sf

from backend.recordings.studio_audio import _check_cancel, _profile, _temporary_wave


def shift_audio(source: Path, target: Path, shift: int, cancel: threading.Event) -> None:
    """Shift by integer samples with zero padding, never roll or change duration."""
    with (
        sf.SoundFile(source) as original,
        _temporary_wave(
            target, samplerate=original.samplerate, channels=original.channels
        ) as output,
    ):
        for start in range(0, original.frames, 65536):
            _check_cancel(cancel)
            length = min(65536, original.frames - start)
            block = np.zeros((length, original.channels), dtype=np.float32)
            first, last = max(0, start - shift), min(original.frames, start + length - shift)
            if last > first:
                original.seek(first)
                offset = first + shift - start
                block[offset : offset + last - first] = original.read(
                    last - first, dtype="float32", always_2d=True
                )
            output.write(block)


def _onsets(path: Path, cancel: threading.Event) -> np.ndarray:
    db = _profile(path, cancel, voice_band=True, frame_seconds=0.01, band_hz=(180, 3500))
    amplitude = np.power(10.0, db / 20)
    envelope = gaussian_filter1d(amplitude, 0.75)
    # Musical attacks survive polarity, pitch and moderate timbral differences.
    result: np.ndarray = np.maximum(0, np.diff(envelope, prepend=envelope[0]))
    return result


def _window_scores(
    actual: np.ndarray, expected: np.ndarray, start: int, margin: int
) -> list[float]:
    norm = float(np.linalg.norm(expected))
    scores = []
    for lag in range(-margin, margin + 1):
        candidate = actual[start + lag : start + lag + len(expected)]
        scores.append(float(candidate @ expected / max(norm * np.linalg.norm(candidate), 1e-15)))
    return scores


def _onset_evidence(
    actual: np.ndarray, reference: np.ndarray
) -> tuple[list[tuple[int, float, float]], int]:
    count = min(len(actual), len(reference))
    evidence: list[tuple[int, float, float]] = []
    ambiguous = 0
    margin, window = 15, 300
    for start in range(margin, count - window - margin, window):
        expected = reference[start : start + window]
        norm = float(np.linalg.norm(expected))
        if norm < 1e-7 or np.count_nonzero(expected > np.max(reference) * 0.1) < 2:
            continue
        scores = _window_scores(actual, expected, start, margin)
        peak = int(np.argmax(scores))
        lag = peak - margin
        if peak in (0, len(scores) - 1):
            continue
        competing = np.asarray(scores).copy()
        competing[max(0, peak - 2) : peak + 3] = -1
        if scores[peak] - float(np.max(competing)) < 0.1:
            ambiguous += 1
            continue
        evidence.append((lag, scores[peak], scores[peak] - scores[margin]))
    return evidence, ambiguous


def _delay_evidence(actual: np.ndarray, reference: np.ndarray) -> tuple[int, dict[str, object]]:
    evidence, ambiguous = _onset_evidence(actual, reference)
    report: dict[str, object] = {
        "comparedWindows": len(evidence),
        "method": "phrase-onset-consensus",
        "ambiguousWindows": ambiguous,
    }
    if len(evidence) < 3:
        return 0, {
            **report,
            "reason": "ambiguous-onset-periodicity"
            if ambiguous
            else "insufficient-independent-phrases",
        }
    lags, scores, improvements = np.asarray(evidence).T
    center = int(round(float(np.median(lags))))
    agreeing = (abs(lags - center) <= 1) & (scores >= 0.8) & (improvements >= 0.12)
    report.update(
        agreement=float(np.mean(agreeing)),
        medianCorrelation=float(np.median(scores)),
        candidateShiftMs=-center * 10,
    )
    if abs(center) < 2 or np.count_nonzero(agreeing) < 3 or np.mean(agreeing) < 0.75:
        return 0, {**report, "reason": "no-consistent-recording-delay"}
    return -center, {**report, "reason": "confirmed-consistent-recording-delay"}


def _would_drop_voice(source: Path, shift: int, cancel: threading.Event) -> bool:
    if not shift:
        return False
    with sf.SoundFile(source) as original:
        count = min(abs(shift), original.frames)
        original.seek(0 if shift < 0 else original.frames - count)
        edge = original.read(count, dtype="float32", always_2d=True)
        # Use the take's own scale: a quiet microphone may later receive substantial
        # gain. A fixed dBFS threshold would delete its meaningful boundary syllables.
        levels = _profile(source, cancel)
        scale = 10 ** (float(np.percentile(levels, 95)) / 20)
        return bool(np.max(abs(edge), initial=0) > max(1e-9, scale * 0.005))


def align_voice(
    source: Path, reference: Path | None, target: Path, cancel: threading.Event
) -> dict[str, object]:
    _check_cancel(cancel)
    if reference is None:
        shutil.copyfile(source, target)
        return {"applied": False, "shiftMs": 0.0, "reason": "unconfirmed-reference-timeline"}
    actual, expected = _onsets(source, cancel), _onsets(reference, cancel)
    lag, report = _delay_evidence(actual, expected)
    rate = sf.info(source).samplerate
    shift = round(lag * rate * 0.01)
    if _would_drop_voice(source, shift, cancel):
        shift = 0
        report["reason"] = "boundary-audio-preserved"
    if shift:
        shift_audio(source, target, shift, cancel)
    else:
        shutil.copyfile(source, target)
    return {
        **report,
        "applied": bool(shift),
        "shiftMs": shift / rate * 1000,
        "sampleShift": shift,
        "timeStretchApplied": False,
    }
