from __future__ import annotations

from pathlib import Path

import torch
import torchcrepe

from backend.ai_worker.audio_io import read_mono
from backend.ai_worker.runtime import device

_SAMPLE_RATE = 16_000
_HOP_SAMPLES = 160  # 10 ms
_FMIN, _FMAX = 65.0, 1100.0
_BATCH = 512
_SMOOTHING = 3


def pitch(vocal: Path) -> dict[str, list[dict[str, float]]]:
    target = device()
    audio = torch.from_numpy(read_mono(vocal, _SAMPLE_RATE))[None]
    frequency, periodicity = torchcrepe.predict(
        audio,
        _SAMPLE_RATE,
        _HOP_SAMPLES,
        _FMIN,
        _FMAX,
        model="full" if target == "cuda" else "tiny",
        batch_size=_BATCH,
        device=target,
        return_periodicity=True,
    )
    periodicity = torchcrepe.filter.median(periodicity, _SMOOTHING)
    step = _HOP_SAMPLES / _SAMPLE_RATE
    points = [
        {
            "time": round(index * step, 3),
            "frequency": round(float(frequency[0, index]), 2),
            "confidence": round(float(periodicity[0, index]), 3),
        }
        for index in range(frequency.shape[-1])
    ]
    return {"points": points}
