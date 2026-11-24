from __future__ import annotations

from pathlib import Path
from functools import lru_cache, partial
from collections.abc import Callable
import os
from types import MappingProxyType

from librosa.util import tiny
from numba import njit
import numpy as np
from scipy.ndimage import uniform_filter1d
import torch
import torchcrepe

from backend.ai_worker.audio_io import read_mono
from backend.ai_worker.runtime import device
from backend.ai_worker.timing import _BRIDGED_GAP_SECONDS, _runs, audible_frames

_SAMPLE_RATE = 16_000
_HOP_SAMPLES = 160  # 10 ms
_FMIN, _FMAX = 65.0, 1100.0
_BATCH = MappingProxyType({"cpu": 512, "cuda": 128})
_SMOOTHING = 3
_BAND_BINS = 11
_PERIOD_SAMPLES = 640  # 40 ms


def _pitch_inference(target: str) -> Callable[[torch.Tensor], torch.Tensor]:
    directory = os.getenv("AD_VOICE_TENSORRT_PITCH")
    if target == "cuda" and directory:
        from backend.ai_worker.tensorrt_pitch import TensorRTPitch

        return TensorRTPitch(Path(directory))
    return partial(torchcrepe.infer, model="full", device=target)


@njit(cache=True)
def _band_viterbi(
    log_prob: np.ndarray, log_transition: np.ndarray, initial: np.ndarray, floor: float
) -> tuple[np.ndarray, np.ndarray]:
    """CREPE's 23-bin band plus librosa's finite off-band epsilon, including ties."""
    frames, states = log_prob.shape
    value = log_prob[0] + initial
    following = np.zeros(states, dtype=np.float64)
    ptr = np.zeros((frames, states), dtype=np.uint16)
    path = np.zeros(frames, dtype=np.uint16)
    for t in range(1, frames):
        # Include every floor candidate; a band's actual transition dominates
        # its floor. Compare rounded sums, retaining the lowest index on ties.
        floors = value + floor
        global_best = int(np.argmax(floors))
        for j in range(states):
            low, high = max(0, j - _BAND_BINS), min(states, j + _BAND_BINS + 1)
            best, chosen = -np.inf, 0
            for k in range(low, high):
                cost = value[k] + log_transition[k, j]
                if cost > best:
                    best, chosen = cost, k
            if floors[global_best] > best or (floors[global_best] == best and global_best < chosen):
                best, chosen = floors[global_best], global_best
            following[j] = log_prob[t, j] + best
            ptr[t, j] = chosen
        value, following = following, value
    path[-1] = np.argmax(value)
    for t in range(frames - 2, -1, -1):
        path[t] = ptr[t + 1, path[t + 1]]
    return path, value[path[-1] : path[-1] + 1]


@lru_cache(maxsize=3)
def _decoder_parameters(epsilon: float) -> tuple[np.ndarray, np.ndarray, float]:
    xx, yy = np.meshgrid(range(360), range(360))
    transition = np.maximum(_BAND_BINS + 1 - abs(xx - yy), 0)
    transition = transition / transition.sum(axis=1, keepdims=True)
    return (
        np.log(transition + epsilon),
        np.log(np.full(360, 1 / 360) + epsilon),
        float(np.log(epsilon)),
    )


def _viterbi_decoder(
    logits: torch.Tensor, *, active: np.ndarray | None = None
) -> tuple[torch.Tensor, torch.Tensor]:
    with torch.no_grad():
        if active is not None:
            # Silence must not pull the next entry off pitch. Retain the original
            # probabilities in postprocess for quiet-frame confidence and smoothing.
            quiet = ~torch.as_tensor(active, device=logits.device)[None, None]
            logits = logits.masked_fill(quiet & torch.isfinite(logits), 0)
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
    # The native bin conversion adds random dither; retain the measured bin centres.
    cents = torchcrepe.CENTS_PER_BIN * indices + 1997.3794084376191
    return indices, torchcrepe.convert.cents_to_frequency(cents)


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
    """Infer in small batches, then decode one continuous musical timeline."""
    audio = torch.from_numpy(samples)[None]
    if not active.any():
        frequency = torch.zeros((1, len(active)))
        return frequency, torch.zeros_like(frequency)
    probabilities = torch.zeros((1, 360, len(active)))
    infer = _pitch_inference(target)
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
        probabilities[:, :, first:last] = infer(frames).T.cpu()
    frequency, periodicity = torchcrepe.postprocess(
        probabilities,
        _FMIN,
        _FMAX,
        decoder=partial(_viterbi_decoder, active=active),
        return_periodicity=True,
    )
    # A real note entry must not become an unsupported glide between distant pitches.
    peak_confidence, bins = probabilities.max(dim=1)
    supported = (periodicity < 0.5) & (peak_confidence >= 0.5) & torch.from_numpy(active)[None]
    centres = torchcrepe.convert.cents_to_frequency(
        torchcrepe.CENTS_PER_BIN * bins + 1997.3794084376191
    )
    supported &= _entry_support(frequency, periodicity, centres, active)
    return torch.where(supported, centres, frequency), torch.where(
        supported, peak_confidence, periodicity
    )


def _entry_support(
    frequency: torch.Tensor, confidence: torch.Tensor, centres: torch.Tensor, active: np.ndarray
) -> torch.Tensor:
    """Recover entries adjoining a confirmed pitch, without promoting isolated harmonics."""
    margin = round(_BRIDGED_GAP_SECONDS * _SAMPLE_RATE / _HOP_SAMPLES)
    nearby: torch.Tensor = torch.nn.functional.pad(frequency, (margin, margin)).unfold(
        -1, 2 * margin + 1, 1
    )
    trusted: torch.Tensor = torch.nn.functional.pad(
        confidence * torch.from_numpy(active)[None], (margin, margin)
    ).unfold(-1, 2 * margin + 1, 1)
    distance = torch.abs(torch.log2(nearby.clamp_min(1) / centres[..., None]))
    return torch.any(
        (trusted >= 0.5) & (distance <= _BAND_BINS * torchcrepe.CENTS_PER_BIN / 1200), dim=-1
    )


@njit(cache=True)
def _period_correlation(samples: np.ndarray, center: int, lag: int) -> float:
    # Compare 40 ms of the vowel on both sides of the same frame center.
    first = center - _PERIOD_SAMPLES // 2 - lag // 2
    last = first + _PERIOD_SAMPLES
    if first < 0 or last + lag > len(samples):
        return 0.0
    best = 0.0
    for period in range(lag - 2, lag + 3):
        if last + period > len(samples):
            continue
        product = left_energy = right_energy = 0.0
        for index in range(first, last):
            left, right = samples[index], samples[index + period]
            product += left * right
            left_energy += left * left
            right_energy += right * right
        best = max(best, product / (np.sqrt(left_energy * right_energy) + 1e-12))
    return best


def _acoustic_pitch_support(
    samples: np.ndarray, frequency: torch.Tensor, confidence: torch.Tensor, active: np.ndarray
) -> torch.Tensor:
    values = frequency[0].numpy()
    supported = confidence[0].numpy().copy()
    maximum = round(_BRIDGED_GAP_SECONDS * _SAMPLE_RATE / _HOP_SAMPLES)
    margin = _PERIOD_SAMPLES // 2 + round(_SAMPLE_RATE / _FMIN) + 2
    for first, last in _runs(active & (supported >= 0.5), True):
        if last - first > maximum:
            continue
        correlations = [
            _period_correlation(samples, index * _HOP_SAMPLES, round(_SAMPLE_RATE / values[index]))
            for index in range(first, last)
            if values[index] >= _FMIN and margin <= index * _HOP_SAMPLES < len(samples) - margin
        ]
        # Without a complete analysis window, retain the existing uncertainty at file edges.
        if correlations and float(np.median(correlations)) < 0.5:
            supported[first:last] = 0
    return torch.from_numpy(supported)[None]


@njit(cache=True)
def _octave_evidence(
    samples: np.ndarray, frequencies: np.ndarray, voiced: np.ndarray
) -> np.ndarray:
    correlations = np.zeros((3, len(frequencies)), dtype=np.float32)
    for index, frequency in enumerate(frequencies):
        if voiced[index] and frequency >= 2 * _FMIN:
            center = index * _HOP_SAMPLES
            lag = _SAMPLE_RATE / frequency
            correlations[0, index] = _period_correlation(samples, center, round(lag))
            correlations[1, index] = _period_correlation(samples, center, round(2 * lag))
            if frequency >= 4 * _FMIN:
                correlations[2, index] = _period_correlation(samples, center, round(4 * lag))
    return correlations


def _held_octave(lower: np.ndarray, gain: np.ndarray) -> np.ndarray:
    # Require sustained evidence so a transient or vibrato cannot shift the octave.
    supported = (lower >= 0.85) & (gain >= 0.065)
    sustained = uniform_filter1d(supported.astype(np.float32), 11) >= 0.5
    eligible = (lower >= 0.8) & (gain >= 0.015)
    corrected = np.asarray(sustained & eligible, dtype=bool)
    for start, end in _runs(eligible, True):
        evidence = np.flatnonzero(corrected[start:end])
        if evidence.size:
            # Keep a held octave through quieter harmonics only between confirmed frames.
            corrected[start + evidence[0] : start + evidence[-1] + 1] = True
    return corrected


def _correct_octave(
    samples: np.ndarray, frequency: torch.Tensor, periodicity: torch.Tensor, active: np.ndarray
) -> torch.Tensor:
    values = frequency[0].numpy()
    voiced = active & (periodicity[0].numpy() >= 0.5)
    if not voiced.any():
        return frequency
    base, lower, lowest = _octave_evidence(samples, values, voiced)
    # A fourth harmonic can hide the fundamental across both shorter periods.
    two_octaves = _held_octave(lowest, lowest - np.maximum(base, lower))
    one_octave = _held_octave(lower, lower - base)
    corrected = np.where(two_octaves, values / 4, np.where(one_octave, values / 2, values))
    return torch.from_numpy(corrected)[None]


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
    frequency = _correct_octave(samples, frequency, periodicity, active)
    periodicity = _acoustic_pitch_support(samples, frequency, periodicity, active)
    step = _HOP_SAMPLES / _SAMPLE_RATE
    return {"points": _pitch_points(frequency, periodicity, step, active)}
