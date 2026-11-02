from __future__ import annotations

from pathlib import Path
from functools import lru_cache
from types import MappingProxyType

from librosa.util import tiny
from numba import njit
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


@njit(cache=True)
def _band_viterbi(
    log_prob: np.ndarray, log_transition: np.ndarray, initial: np.ndarray, floor: float
) -> tuple[np.ndarray, np.ndarray]:
    """CREPE's 23-bin band plus librosa's finite off-band epsilon, including ties."""
    frames, states = log_prob.shape
    value = np.zeros((frames, states), dtype=np.float64)
    ptr = np.zeros((frames, states), dtype=np.uint16)
    path = np.zeros(frames, dtype=np.uint16)
    value[0] = log_prob[0] + initial
    for t in range(1, frames):
        # Include every floor candidate; a band's actual transition dominates
        # its floor. Compare rounded sums, retaining the lowest index on ties.
        floors = value[t - 1] + floor
        global_best = int(np.argmax(floors))
        for j in range(states):
            low, high = max(0, j - 11), min(states, j + 12)
            best, chosen = -np.inf, 0
            for k in range(low, high):
                cost = value[t - 1, k] + log_transition[k, j]
                if cost > best:
                    best, chosen = cost, k
            if floors[global_best] > best or (floors[global_best] == best and global_best < chosen):
                best, chosen = floors[global_best], global_best
            value[t, j] = log_prob[t, j] + best
            ptr[t, j] = chosen
    path[-1] = np.argmax(value[-1])
    for t in range(frames - 2, -1, -1):
        path[t] = ptr[t + 1, path[t + 1]]
    return path, value[-1:, path[-1]]


@lru_cache(maxsize=3)
def _decoder_parameters(epsilon: float) -> tuple[np.ndarray, np.ndarray, float]:
    xx, yy = np.meshgrid(range(360), range(360))
    transition = np.maximum(12 - abs(xx - yy), 0)
    transition = transition / transition.sum(axis=1, keepdims=True)
    return (
        np.log(transition + epsilon),
        np.log(np.full(360, 1 / 360) + epsilon),
        float(np.log(epsilon)),
    )


def _viterbi_decoder(logits: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    with torch.no_grad():
        probs = torch.nn.functional.softmax(logits, dim=1)
    sequences = probs.cpu().numpy()
    transition, initial, floor = _decoder_parameters(float(tiny(sequences)))
    bins = np.array(
        [
            _band_viterbi(np.log(sequence + tiny(sequence)).T, transition, initial, floor)[0]
            for sequence in sequences
        ],
        dtype=np.int64,
    )
    indices = torch.tensor(bins, device=probs.device)
    return indices, torchcrepe.convert.bins_to_frequency(indices)


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
            probabilities.T[None], _FMIN, _FMAX, decoder=_viterbi_decoder, return_periodicity=True
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
