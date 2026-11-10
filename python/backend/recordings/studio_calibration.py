from collections.abc import Callable
from pathlib import Path
from copy import deepcopy
import shutil
import numpy as np

from backend.recordings.studio_mix_audit import audit_mix, reference_voice_band_distribution


def distribution_improved(
    reference: dict[str, float], before: dict[str, object], after: dict[str, object]
) -> bool:
    residual = "outputVsStemSumResidualMedianDb"
    old_residual, new_residual = before.get(residual), after.get(residual)
    if isinstance(old_residual, (int, float)) and isinstance(new_residual, (int, float)):
        # Ignore changes below the encoded PCM noise floor, not audible limiting.
        if not np.isfinite(new_residual) or new_residual > max(-80.0, old_residual):
            return False
    fields = {
        "p10": "voiceBandVocalToBackingP10Db",
        "median": "voiceBandVocalToBackingMedianDb",
        "p90": "voiceBandVocalToBackingP90Db",
    }
    errors = []
    for label, field in fields.items():
        old, new = before.get(field), after.get(field)
        if not isinstance(old, (int, float)) or not isinstance(new, (int, float)):
            return False
        if not all(np.isfinite(v) for v in (reference[label], old, new)):
            return False
        errors.append((abs(reference[label] - old), abs(reference[label] - new)))
    return all(new <= old for old, new in errors) and sum(new for _, new in errors) < sum(
        old for old, _ in errors
    )


def calibrate_mix(
    vocal: Path,
    backing: Path,
    target: Path,
    reference: Path,
    original: Path,
    section: tuple[float, float] | None,
    deliver: Callable[[float], None],
    processing: dict[str, object],
) -> float:
    audit = audit_mix(vocal, backing, target)
    processing["postMixAudit"] = audit
    expected = (
        reference_voice_band_distribution(reference, original, time_range=section)
        if section
        else None
    )
    current = audit.get("voiceBandVocalToBackingMedianDb")
    processing["postMixReferenceScope"] = (
        "matched-recording-section" if section else "unmatched-skip-global-feedback"
    )
    if not expected or not isinstance(current, (int, float)):
        processing["postMixCalibration"] = {"status": "skipped-insufficient-reference-data"}
        return 0.0
    error = expected["median"] - current
    correction = float(np.clip(error, -3.0, 3.0)) if abs(error) > 1.0 else 0.0
    gain = (
        _try_correction(vocal, backing, target, expected, deliver, processing, correction)
        if correction
        else 0.0
    )
    processing["postMixCalibration"] = {
        "status": "improved" if gain else "rejected-or-already-balanced",
        "referenceVoiceBandDb": expected["median"],
        "beforeVoiceBandDb": current,
        "requestedCorrectionDb": correction,
        "correctionDb": gain,
        "method": "reference-measured-accept-only-if-improved",
    }
    return gain


def _try_correction(
    vocal: Path,
    backing: Path,
    target: Path,
    expected: dict[str, float],
    deliver: Callable[[float], None],
    processing: dict[str, object],
    correction: float,
) -> float:
    previous = target.with_suffix(".pre-calibration.wav")
    shutil.copyfile(target, previous)
    old = deepcopy(processing)
    accepted = False
    try:
        deliver(correction)
        candidate = audit_mix(vocal, backing, target, vocal_gain_db=correction)
        before = old["postMixAudit"]
        accepted = isinstance(before, dict) and distribution_improved(expected, before, candidate)
        if accepted:
            processing["postMixAudit"] = candidate
        return correction if accepted else 0.0
    finally:
        if not accepted:
            shutil.copyfile(previous, target)
            processing.clear()
            processing.update(old)
        previous.unlink(missing_ok=True)
