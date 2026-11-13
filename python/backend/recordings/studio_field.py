from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Mapping
import math
import threading
import numpy as np
import soundfile as sf
from scipy.optimize import nnls
from scipy.signal import butter, sosfilt
from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_space_analysis import _field_envelopes


@dataclass(frozen=True, slots=True)
class DiffuseFieldPlan:
    response: np.ndarray
    ratio: float
    improvement: float


def _delayed_kernel(envelopes: np.ndarray) -> tuple[np.ndarray, float] | None:
    scale = max(float(np.percentile(envelopes[:, 0], 85)), 1e-10)
    mid, side = (envelopes / scale).T
    windows = np.lib.stride_tricks.sliding_window_view(np.pad(mid, (30, 0)), 31)[:, ::-1]
    partition = (np.arange(len(mid)) // 150) % 2 == 0
    kernels, scores = [], []
    for training in (partition, ~partition):
        try:
            baseline, _ = nnls(windows[training, :1], side[training])
            base_error = float(np.mean((windows[~training, :1] @ baseline - side[~training]) ** 2))
            if base_error <= float(np.mean(side[~training] ** 2)) * 1e-8:
                return None
            kernel, _ = nnls(windows[training], side[training])
        except RuntimeError:
            return None
        error = float(np.mean((windows[~training] @ kernel - side[~training]) ** 2))
        scores.append(1 - error / max(base_error, 1e-20))
        kernels.append(kernel)
    if min(scores) < 0.05:
        return None
    kernel = np.mean(kernels, axis=0)
    kernel[0] = 0
    return kernel, min(scores)


def plan_diffuse_field(
    reference: Path, rate: int, cancel: threading.Event
) -> DiffuseFieldPlan | None:
    if rate <= 7000:
        return None
    envelopes = _field_envelopes(reference, cancel)
    if len(envelopes) < 450:
        return None
    fitted = _delayed_kernel(envelopes[:, 1])
    if fitted is None:
        return None
    kernel, improvement = fitted
    observed = float(envelopes[:, 1, 1].sum() / max(envelopes[:, 1, 0].sum(), 1e-20))
    ratio = min(float(kernel.sum()), observed)
    if ratio < 1e-4:
        return None
    time = np.arange(round(rate * 0.64)) / rate
    power = np.interp(time, np.arange(len(kernel)) * 0.02, kernel, right=0)
    noise = np.random.default_rng(0).normal(size=len(time)) * np.sqrt(power)
    noise[: round(rate * 0.02)] = 0
    response = sosfilt(butter(2, [500, 3500], fs=rate, btype="bandpass", output="sos"), noise)
    response /= max(float(np.linalg.norm(response)), 1e-12)
    return DiffuseFieldPlan(response, ratio, improvement)


def _field_energy(
    voice: Path, paths: Mapping[str, Path], gains: Mapping[str, float], cancel: threading.Event
) -> np.ndarray:
    energy = np.zeros((3, 3))
    with ExitStack() as stack:
        dry = stack.enter_context(sf.SoundFile(voice))
        readers = {name: stack.enter_context(sf.SoundFile(path)) for name, path in paths.items()}
        band = butter(2, [500, 3500], fs=dry.samplerate, btype="bandpass", output="sos")
        state = np.zeros((len(band), 2, 3))
        for block in dry.blocks(blocksize=32768, always_2d=True):
            _check_cancel(cancel)
            current = block.copy()
            diffuse = np.zeros(len(block))
            for name, reader in readers.items():
                wet = reader.read(len(block), always_2d=True)
                if name == "diffuse-field":
                    diffuse = (wet[:, 0] - wet[:, 1]) / 2
                else:
                    current += wet * gains[name]
            signals = np.column_stack(
                (current.mean(axis=1), (current[:, 0] - current[:, 1]) / 2, diffuse)
            )
            filtered, state = sosfilt(band, signals, axis=0, zi=state)
            energy += filtered.T @ filtered
    return energy


def calibrate_diffuse_field(
    voice: Path,
    paths: Mapping[str, Path],
    gains: Mapping[str, float],
    plan: DiffuseFieldPlan,
    peak_limit: float,
    cancel: threading.Event,
) -> tuple[float, dict[str, object]]:
    energy = _field_energy(voice, paths, gains, cancel)
    mid, side, diffuse = map(float, np.diag(energy))
    cross = float(energy[1, 2])
    target = plan.ratio * mid
    missing = max(0.0, target - side)
    if missing <= max(target, side, 1e-20) * 1e-10:
        missing = 0.0
    desired = (
        (-cross + math.sqrt(max(0.0, cross**2 + diffuse * missing))) / diffuse
        if missing > 0 and diffuse > 1e-20
        else 0.0
    )
    gain = min(desired, peak_limit)
    return gain, {
        "applied": gain > 0,
        "method": "cross-validated-delayed-side-energy",
        "heldOutImprovement": plan.improvement,
        "targetSideToMidRatio": plan.ratio,
        "beforeSideToMidRatio": float(side / max(mid, 1e-20)),
        "afterSideToMidRatio": float(
            (side + 2 * gain * cross + gain**2 * diffuse) / max(mid, 1e-20)
        ),
        "peakLimited": gain < desired,
        "centerPreserved": True,
    }
