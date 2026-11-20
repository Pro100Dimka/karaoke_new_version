"""Bounded CPU pYIN analysis for offline, single-performer mastering.

The probability threshold deliberately leaves uncertain or unvoiced material
untuned. Chunk context belongs to analysis only; every returned point stays on
the original recording's exact 10 ms timeline.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from functools import partial
from pathlib import Path
import threading

import librosa
import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly
import soundfile as sf

from backend.ai.domain import PitchPoint
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel
from backend.recordings.studio_parallel import ScheduledMap, ordered_map, schedule_map
from backend.recordings.studio_pitch_probabilities import fast_pyin

FloatArray = NDArray[np.float64]
_RATE = 16000
_FRAME = 1024
_BASS_FRAME = 3072
_HOP = 160
_CHUNK_SECONDS = 16
_CONTEXT_FRAMES = 32
_MIN_CONFIDENCE = 0.75


def _mono(samples: FloatArray) -> FloatArray:
    if not np.isfinite(samples).all():
        raise DependencyError("StudioMasterInvalidAudio", "Audio contains non-finite samples")
    strongest = int(np.argmax(np.mean(samples**2, axis=0)))
    mono = np.mean(samples, axis=1)
    channel_energy = float(np.mean(samples[:, strongest] ** 2))
    # A phase-inverted stereo capture must not disappear in the analysis sum.
    if float(np.mean(mono**2)) < channel_energy * 0.2:
        return samples[:, strongest].copy()
    return mono


def _read_chunk(audio: sf.SoundFile, first: int, last: int) -> FloatArray:
    start = round(first * audio.samplerate / 100)
    end = min(audio.frames, round(last * audio.samplerate / 100))
    audio.seek(start)
    samples = _mono(audio.read(end - start, dtype="float64", always_2d=True))
    divisor = math.gcd(audio.samplerate, _RATE)
    return np.asarray(
        resample_poly(samples, _RATE // divisor, audio.samplerate // divisor), dtype=np.float64
    )


def _activity(samples: FloatArray) -> NDArray[np.bool_]:
    rms = librosa.feature.rms(
        y=samples, frame_length=_FRAME, hop_length=_HOP, center=True, pad_mode="constant"
    )[0]
    threshold = max(1e-6, float(np.percentile(rms, 95)) * 0.001)
    return np.asarray(rms > threshold, dtype=np.bool_)


def _estimate(
    samples: FloatArray, cancel: threading.Event
) -> tuple[FloatArray, FloatArray, NDArray[np.bool_]]:
    active = _activity(samples)
    if len(samples) < _FRAME or not np.any(active):
        return np.zeros(len(active)), np.zeros(len(active)), active
    _check_cancel(cancel)
    frequency, voiced, probability = fast_pyin(
        librosa.pyin,
        samples,
        fmin=50,
        fmax=1500,
        sr=_RATE,
        frame_length=_FRAME,
        hop_length=_HOP,
        resolution=0.1,
        center=True,
        pad_mode="constant",
    )
    _check_cancel(cancel)
    confidence = np.clip(np.nan_to_num(probability), 0, 1)
    confidence = _bass_confidence(samples, frequency, voiced, confidence, cancel)
    valid = voiced & active & (confidence >= _MIN_CONFIDENCE) & np.isfinite(frequency)
    return np.where(valid, frequency, 0), np.where(active, confidence, 0), active


def _bass_confidence(
    samples: FloatArray,
    frequency: FloatArray,
    voiced: NDArray[np.bool_],
    confidence: FloatArray,
    cancel: threading.Event,
) -> FloatArray:
    candidate = voiced & (frequency < 160) & (confidence < _MIN_CONFIDENCE)
    candidate &= (confidence >= 0.1) & np.isfinite(frequency)
    if len(samples) < _BASS_FRAME or not np.any(candidate):
        return confidence
    # 1024 samples contain too few bass periods for pYIN's probability model.
    # Confirm periodicity over a longer window, retaining the short-window F0
    # so the longer observation cannot smear vibrato or note transitions.
    _check_cancel(cancel)
    bass, sustained, probability = fast_pyin(
        librosa.pyin,
        samples,
        fmin=50,
        fmax=1500,
        sr=_RATE,
        frame_length=_BASS_FRAME,
        hop_length=_HOP,
        resolution=0.1,
        center=True,
        pad_mode="constant",
    )
    _check_cancel(cancel)
    agreement = abs(1200 * np.log2(np.maximum(frequency, 1) / np.maximum(bass, 1)))
    confirmed = candidate & sustained & (agreement < 25) & np.isfinite(probability)
    return np.where(confirmed, np.clip(probability, 0, 1), confidence)


def _chunk_points(
    audio: sf.SoundFile, first: int, last: int, count: int, cancel: threading.Event
) -> list[PitchPoint]:
    left = max(0, first - _CONTEXT_FRAMES)
    right = min(count, last + _CONTEXT_FRAMES)
    _check_cancel(cancel)
    samples = _read_chunk(audio, left, right)
    frequency, confidence, active = _estimate(samples, cancel)
    _check_cancel(cancel)
    return [
        PitchPoint(
            time=index / 100,
            frequency=float(frequency[index - left]),
            confidence=float(confidence[index - left]),
            audio_active=bool(active[index - left]),
        )
        for index in range(first, last)
    ]


def analyze_pitch(path: Path, cancel: threading.Event) -> tuple[PitchPoint, ...]:
    """Measure trusted monophonic F0 without loading the full audio or a CNN."""
    worker, offsets = _pitch_work(path, cancel)
    points: list[PitchPoint] = []
    for result in ordered_map(worker, offsets):
        points.extend(result)
    _check_cancel(cancel)
    return tuple(points)


def prefetch_pitch(path: Path, cancel: threading.Event) -> ScheduledMap[int, list[PitchPoint]]:
    """Start existing chunks within the render's bounded shared worker queue."""
    worker, offsets = _pitch_work(path, cancel)
    return schedule_map(worker, offsets)


def _pitch_work(
    path: Path, cancel: threading.Event
) -> tuple[Callable[[int], list[PitchPoint]], range]:
    _check_cancel(cancel)
    with sf.SoundFile(path) as audio:
        if audio.frames == 0 or audio.samplerate < 1000:
            raise DependencyError("StudioMasterInvalidAudio", "Audio has no valid samples")
        count = (audio.frames * 100 + audio.samplerate - 1) // audio.samplerate
    chunk = round(_CHUNK_SECONDS * 100)
    worker = partial(_path_points, path, count, chunk, cancel)
    return worker, range(0, count, chunk)


def _path_points(
    path: Path, count: int, chunk: int, cancel: threading.Event, first: int
) -> list[PitchPoint]:
    _check_cancel(cancel)
    # Each worker seeks its own handle; pYIN context and crop remain unchanged.
    with sf.SoundFile(path) as audio:
        return _chunk_points(audio, first, min(count, first + chunk), count, cancel)
