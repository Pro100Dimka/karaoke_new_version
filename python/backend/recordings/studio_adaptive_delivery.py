"""Reference-aware master delivery with bounded compression and measured true peak."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
import math
import re
import threading

import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _profile


def measure_loudness(
    renderer: MasterRenderer, source: Path, cancel: threading.Event
) -> dict[str, float | None]:
    """EBU R128 integration and oversampled true peak, without normalizing the audio."""
    result = renderer._mix(
        source,
        source,
        "[0:a]ebur128=peak=true:framelog=verbose[out]",
        ["-f", "null", "-"],
        cancel,
        quiet=False,
    )
    values: dict[str, float | None] = {}
    for key, pattern in (
        ("integratedLufs", rb"\bI:\s+([-\d.inf]+) LUFS"),
        ("truePeakDbtp", rb"Peak:\s+([-\d.inf]+) dBFS"),
        ("loudnessRangeLu", rb"\bLRA:\s+([-\d.inf]+) LU"),
    ):
        matches = re.findall(pattern, result.stderr)
        if not matches:
            raise DependencyError("StudioMasterInvalidAudio", "Loudness measurement is incomplete")
        value = float(matches[-1])
        values[key] = value if math.isfinite(value) else None
    # R128 cannot integrate a partial 400 ms block or a gated-out signal.
    integrated = values["integratedLufs"]
    if sf.info(source).duration < 0.4 or (integrated is not None and integrated <= -70):
        values["integratedLufs"] = None
    return values


def _glue(
    renderer: MasterRenderer, source: Path, target: Path, cancel: threading.Event
) -> tuple[Path, dict[str, object]]:
    levels = _profile(source, cancel)
    active = levels > max(-80.0, float(np.max(levels)) - 40)
    spread = (
        float(np.percentile(levels[active], 95) - np.percentile(levels[active], 30))
        if active.any()
        else 0.0
    )
    if np.count_nonzero(active) < 10 or spread < 4:
        return source, {"applied": False, "reason": "no-excess-mix-dynamics", "maxReductionDb": 0.0}
    threshold = float(np.clip(np.percentile(levels[active], 70), -54, -3))
    # Parallel dry fraction bounds even an extreme detector event to -1.94 dB.
    renderer._mix(
        source,
        source,
        f"[0:a]acompressor=threshold={10 ** (threshold / 20):.9f}:ratio=2:"
        "attack=30:release=200:knee=2:makeup=1:mix=0.2:link=maximum:detection=rms[out]",
        ["-c:a", "pcm_f32le", str(target)],
        cancel,
    )
    after = _profile(target, cancel)
    reduction = np.maximum(0, levels[active] - after[active])
    return target, {
        "applied": True,
        "method": "parallel-linked-rms-compressor",
        "thresholdDbfs": threshold,
        "ratio": 2.0,
        "wetFraction": 0.2,
        "maxReductionDb": float(np.max(reduction, initial=0)),
        "medianReductionDb": float(np.median(reduction)),
        "boundDb": -20 * math.log10(0.8),
    }


@dataclass(frozen=True, slots=True)
class DeliveryPlan:
    reference_i: float | None
    target_i: float
    source_i: float | None
    source_tp: float | None
    gain: float
    headroom: float
    oversampled: int


def _measure_pair(
    renderer: MasterRenderer, source: Path, reference: Path | None, cancel: threading.Event
) -> tuple[dict[str, float | None], dict[str, float | None] | None]:
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="master-meter") as pool:
        current = pool.submit(measure_loudness, renderer, source, cancel)
        expected = pool.submit(measure_loudness, renderer, reference, cancel) if reference else None
        return current.result(), expected.result() if expected else None


def _delivery_plan(
    measured: dict[str, float | None], original: dict[str, float | None] | None, rate: int
) -> DeliveryPlan:
    reference_i = original["integratedLufs"] if original else None
    target_i = float(np.clip(reference_i, -24, -9)) if reference_i is not None else -16.0
    source_i, source_tp = measured["integratedLufs"], measured["truePeakDbtp"]
    desired = target_i - source_i if source_i is not None else 0.0
    headroom = -1.3 - source_tp if source_tp is not None else 0.0
    # A target cannot force more than two dB of planned transient limiting.
    gain = min(desired, headroom + 2.0, 12.0) if source_tp is not None else 0.0
    return DeliveryPlan(
        reference_i, target_i, source_i, source_tp, gain, headroom, max(rate, min(192000, rate * 4))
    )


def _encode_limited(
    renderer: MasterRenderer,
    source: Path,
    candidate: Path,
    plan: DeliveryPlan,
    info: sf._SoundFileInfo,
    cancel: threading.Event,
) -> None:
    graph = (
        f"[0:a]aresample={plan.oversampled},volume={plan.gain:.9f}dB,"
        "alimiter=limit=0.860993753:attack=5:release=80:level=0:latency=1,"
        f"aresample={info.samplerate},apad,atrim=end_sample={info.frames}[out]"
    )
    output = [
        "-ar",
        str(info.samplerate),
        "-ac",
        str(info.channels),
        "-c:a",
        "pcm_s24le",
        str(candidate),
    ]
    renderer._mix(source, source, graph, output, cancel)


def _verify_output(
    renderer: MasterRenderer, candidate: Path, info: sf._SoundFileInfo, cancel: threading.Event
) -> tuple[Path, dict[str, float | None], float]:
    final = measure_loudness(renderer, candidate, cancel)
    correction, peak = 0.0, final["truePeakDbtp"]
    if peak is not None and peak > -1.1:
        correction = -1.3 - peak
        corrected = candidate.with_name("corrected.wav")
        renderer._mix(
            candidate,
            candidate,
            f"[0:a]volume={correction:.9f}dB[out]",
            ["-c:a", "pcm_s24le", str(corrected)],
            cancel,
        )
        candidate, final = corrected, measure_loudness(renderer, corrected, cancel)
    peak = final["truePeakDbtp"]
    if peak is not None and peak > -1.0:
        raise DependencyError("StudioMasterInvalidAudio", "Master exceeds the true-peak ceiling")
    actual = sf.info(candidate)
    if (actual.frames, actual.samplerate, actual.channels) != (
        info.frames,
        info.samplerate,
        info.channels,
    ):
        raise DependencyError("StudioMasterInvalidAudio", "Master format or duration changed")
    return candidate, final, correction


def _delivery_report(
    plan: DeliveryPlan,
    final: dict[str, float | None],
    correction: float,
    compression: dict[str, object],
    rate: int,
) -> dict[str, object]:
    achieved_i = final["integratedLufs"]
    return {
        "method": "reference-loudness-bounded-oversampled-limiter",
        "referenceLufs": plan.reference_i,
        "targetLufs": plan.target_i,
        "targetSource": "performed-reference"
        if plan.reference_i is not None
        else "conservative-fallback",
        "inputIntegratedLufs": plan.source_i,
        "inputTruePeakDbtp": plan.source_tp,
        "globalGainDb": plan.gain + correction,
        "gainDb": plan.gain + correction,
        "peakCorrectionDb": correction,
        "plannedLimiterReductionDb": max(0.0, plan.gain - plan.headroom),
        "glueCompression": compression,
        "oversamplingFactor": plan.oversampled / rate,
        "targetReached": achieved_i is not None and abs(achieved_i - plan.target_i) <= 1.0,
        "targetPolicy": "preserve-transients-when-reference-loudness-exceeds-headroom",
        "limiterCeilingDbfs": -1.3,
        **final,
        "verified": True,
    }


def deliver_master(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference: Path | None = None,
) -> dict[str, object]:
    """Publish only measured PCM; a target LUFS never overrides transient preservation."""
    _check_cancel(cancel)
    info = sf.info(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".delivery-", dir=target.parent) as directory:
        work = Path(directory)
        glued, compression = _glue(renderer, source, work / "glue.wav", cancel)
        measured, original = _measure_pair(renderer, glued, reference, cancel)
        plan = _delivery_plan(measured, original, info.samplerate)
        candidate = work / "candidate.wav"
        _encode_limited(renderer, glued, candidate, plan, info, cancel)
        candidate, final, correction = _verify_output(renderer, candidate, info, cancel)
        _check_cancel(cancel)
        candidate.replace(target)
    return _delivery_report(plan, final, correction, compression, info.samplerate)
