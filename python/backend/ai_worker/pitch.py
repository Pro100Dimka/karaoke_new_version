from __future__ import annotations

from pathlib import Path
from types import MappingProxyType

import numpy as np
import torch
import torchcrepe

from backend.ai_worker.audio_io import read_mono
from backend.ai_worker.runtime import device
from backend.ai_worker.timing import audible_frames

_SAMPLE_RATE = 16_000
_HOP_SAMPLES = 160  # 10 ms
_FMIN, _FMAX = 65.0, 1100.0
_BATCH = MappingProxyType({"cpu": 512, "cuda": 128})
_SMOOTHING = 3


def _pitch_points(
    frequency: torch.Tensor,
    periodicity: torch.Tensor,
    step: float,
    active: np.ndarray | None = None,
) -> list[dict[str, float | bool]]:
    # A scalar read from a CUDA tensor synchronizes the device. Transfer each
    # result once so long songs do not perform tens of thousands of GPU syncs.
    frequencies = frequency[0].detach().cpu().tolist()
    confidences = periodicity[0].detach().cpu().tolist()
    return [
        {
            "time": round(index * step, 3),
            "frequency": round(float(value), 2),
            "confidence": round(float(confidences[index]), 3),
            **({"audioActive": bool(active[index])} if active is not None else {}),
        }
        for index, value in enumerate(frequencies)
    ]


def _predict_active(
    samples: np.ndarray, active: np.ndarray, target: str
) -> tuple[torch.Tensor, torch.Tensor]:
    """Keep CREPE's batches and decoder context; omit only wholly inaudible batches."""
    audio = torch.from_numpy(samples)[None]
    frequency = torch.zeros((1, len(active)))
    periodicity = torch.zeros_like(frequency)
    if not active.any():
        return frequency, periodicity
    batch = _BATCH[target]
    # Include the model's 64-ms receptive field and the final confidence smoothing.
    margin = (_HOP_SAMPLES - 1 + torchcrepe.WINDOW_SIZE // 2) // _HOP_SAMPLES + _SMOOTHING // 2
    for index, frames in enumerate(
        torchcrepe.preprocess(audio, _SAMPLE_RATE, _HOP_SAMPLES, batch, target)
    ):
        first, last = index * batch, index * batch + len(frames)
        if not active[max(0, first - margin) : last + margin].any():
            continue
        # Retain the full model: tiny can mistake harmonics for notes an octave or two higher.
        probabilities = torchcrepe.infer(frames, model="full", device=target)
        predicted, confidence = torchcrepe.postprocess(
            probabilities.T[None], _FMIN, _FMAX, return_periodicity=True
        )
        frequency[:, first:last] = predicted.cpu()
        periodicity[:, first:last] = confidence.cpu()
    return frequency, periodicity


def pitch(vocal: Path) -> dict[str, list[dict[str, float | bool]]]:
    target = device()
    samples = read_mono(vocal, _SAMPLE_RATE)
    active = audible_frames(samples, _HOP_SAMPLES)
    with (
        torch.inference_mode(),
        torch.autocast("cuda", dtype=torch.float16, enabled=target == "cuda"),
    ):
        frequency, periodicity = _predict_active(samples, active, target)
    if periodicity.shape[-1] > _SMOOTHING // 2:
        periodicity = torchcrepe.filter.median(periodicity, _SMOOTHING)
    step = _HOP_SAMPLES / _SAMPLE_RATE
    return {"points": _pitch_points(frequency, periodicity, step, active)}
