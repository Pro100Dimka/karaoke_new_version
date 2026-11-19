"""Reference-band masking evidence independent of broadband vocal gain."""

from pathlib import Path
import threading

import numpy as np
import soundfile as sf
from scipy.ndimage import distance_transform_edt, gaussian_filter1d

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import _check_cancel

_BANDS = ((600, 3500), (600, 1200), (1200, 2400))


def _frame_levels(frames: np.ndarray, rate: int) -> np.ndarray:
    size = frames.shape[1]
    window = np.hanning(size)[None, :, None]
    spectrum = abs(np.fft.rfft(frames * window, axis=1)) ** 2
    hz = np.fft.rfftfreq(size, 1 / rate)
    power = [np.mean(frames**2, axis=(1, 2))]
    denominator = max(1.0, size * float(np.sum(window**2)) * frames.shape[2])
    for low, high in _BANDS:
        selected = (hz >= low) & (hz <= high)
        power.append(2 * np.sum(spectrum[:, selected], axis=(1, 2)) / denominator)
    return np.asarray(10 * np.log10(np.maximum(np.column_stack(power), 1e-12)))


def presence_profile(path: Path, cancel: threading.Event, *, center: bool = False) -> np.ndarray:
    """Measure full, 600–3500, 600–1200 and 1200–2400 Hz powers in one bounded pass."""
    rows = []
    with sf.SoundFile(path) as source:
        size = max(1, round(source.samplerate * 0.1))
        for block in source.blocks(blocksize=size * 32, dtype="float64", always_2d=True):
            _check_cancel(cancel)
            if not np.isfinite(block).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            if center:
                block = block.mean(axis=1, keepdims=True)
            complete = len(block) // size * size
            for frames in (
                block[:complete].reshape(-1, size, block.shape[1]),
                block[complete:][None],
            ):
                if frames.size:
                    rows.extend(_frame_levels(frames, source.samplerate).tolist())
    _check_cancel(cancel)
    return np.asarray(rows, dtype=float).reshape(-1, 4)


def _on_timeline(values: np.ndarray, times: np.ndarray) -> np.ndarray:
    axis = (np.arange(len(values)) + 0.5) * 0.1
    return np.column_stack([np.interp(times, axis, column) for column in values.T])


def _reference_target(
    reference: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
    times: np.ndarray,
    correction_db: float | None,
) -> tuple[np.ndarray, np.ndarray]:
    empty = np.zeros((len(times), 3)), np.zeros((len(times), 3), dtype=bool)
    if reference is None or correction_db is None or not np.isfinite(correction_db):
        return empty
    positions, voice, music = reference
    if not len(positions) or voice.shape != (len(positions), 3) or music.shape != voice.shape:
        return empty
    if not all(np.isfinite(values).all() for values in reference) or np.any(
        np.diff(positions) <= 0
    ):
        return empty
    floor = max(
        -80.0,
        min(float(np.percentile(voice[:, 0], 80)) - 24, float(np.percentile(voice[:, 0], 10)) + 10),
    )
    valid = (voice[:, [0]] > floor) & (voice > -80) & (music > -70)
    if np.count_nonzero(valid[:, 0]) < 10:
        return empty
    target = np.column_stack(
        [np.interp(times, positions, column) + correction_db for column in (voice - music).T]
    )
    supported = np.column_stack(
        [np.interp(times, positions, column, left=0, right=0) > 0.5 for column in valid.T]
    )
    return target, supported


def _supported_smoothing(need: np.ndarray, valid: np.ndarray, step: float) -> np.ndarray:
    result = gaussian_filter1d(need, sigma=0.25 / max(step, 1e-6), axis=0, mode="nearest")
    for column in range(need.shape[1]):
        distance = distance_transform_edt(np.pad(valid[:, column], (1, 1)))[1:-1]
        fade = np.clip((distance - 1) * step / 0.05, 0, 1)
        # Fade inside measured support; zero boundary controls also prevent
        # sample interpolation from spreading EQ into an unsupported breath.
        result[:, column] *= fade**2 * (3 - 2 * fade)
    return np.asarray(result)


def measure_reference_clarity(
    voice: Path,
    backing: Path,
    times: np.ndarray,
    gains: np.ndarray,
    voiced: np.ndarray,
    reference: tuple[np.ndarray, np.ndarray, np.ndarray] | None,
    correction_db: float | None,
    cancel: threading.Event,
) -> tuple[np.ndarray, np.ndarray]:
    target, valid = _reference_target(reference, times, correction_db)
    if not valid.any() or not voiced.any():
        return np.zeros(len(times)), np.zeros((len(times), 2))
    own = _on_timeline(presence_profile(voice, cancel), times)
    music = _on_timeline(presence_profile(backing, cancel, center=True), times)
    valid &= voiced[:, None] & (music[:, 1:] > -70) & (own[:, 1:] > -80)
    valid &= own[:, [1]] > own[:, [0]] - 20
    deficit = target - (own[:, 1:] + gains[:, None] - music[:, 1:])
    valid &= deficit > 0
    need = np.where(valid, np.clip(deficit, 0, 6), 0)
    step = float(np.median(np.diff(times))) if len(times) > 1 else 0.02
    need = _supported_smoothing(need, valid, step)
    _check_cancel(cancel)
    return need[:, 0], np.clip(need[:, 1:], 0, 3)


def clarity_boosts(
    band_deficits: np.ndarray | None,
    need: np.ndarray | None,
    active: np.ndarray,
    prominence: np.ndarray,
) -> np.ndarray:
    if band_deficits is None or need is None:
        return np.asarray(np.clip(-prominence, 0, 3))
    supported = active & (need >= 1)
    return np.asarray(
        np.clip(np.median(band_deficits[supported], axis=0), 0, 3)
        if supported.any()
        else np.zeros_like(prominence)
    )
