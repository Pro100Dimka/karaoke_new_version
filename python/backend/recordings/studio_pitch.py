from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Protocol
import threading
import math
import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from scipy.ndimage import gaussian_filter1d, median_filter, minimum_filter1d

from backend.ai.domain import PitchPoint
from backend.analysis.scoring import parse_playback_adjustments
from backend.recordings.studio_audio import MasterRenderer, _check_cancel, _profile, _temporary_wave
from backend.recordings.studio_reference import mapped_reference_times
from backend.recordings.studio_quality import inspect_master

PitchAnalyzer = Callable[[Path], Sequence[PitchPoint]]


class PitchRender(Protocol):
    renderer: MasterRenderer
    vocal: Path
    reference_vocal: Path
    work: Path
    cancel: threading.Event
    info: sf._SoundFileInfo
    output_channels: int
    pitch: PitchAnalyzer | None
    timing_known: bool
    reliable: NDArray[np.bool_]
    voice_db: NDArray[np.float64]
    gains: NDArray[np.float64]
    backing_db: NDArray[np.float64]
    reference_db: NDArray[np.float64]
    original_db: NDArray[np.float64]
    adjustments: Sequence[Mapping[str, object]]
    pitch_adjustments: Sequence[Mapping[str, object]]
    offset_result: tuple[float, float] | None
    reference_origin: float
    progress: Callable[[str, float, float], None] | None


def _sample_notes(points: Sequence[PitchPoint], times: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if not points:
        return np.zeros(len(times)), np.zeros(len(times), dtype=bool)
    positions = np.array([p.time for p in points])
    frequencies = np.array([p.frequency for p in points])
    confidence = np.array([p.confidence for p in points])
    if not np.isfinite(positions).all() or np.any(np.diff(positions) <= 0):
        return np.zeros(len(times)), np.zeros(len(times), dtype=bool)
    right = np.clip(np.searchsorted(positions, times), 0, len(points) - 1)
    left = np.maximum(0, right - 1)
    indices = np.where(abs(positions[left] - times) < abs(positions[right] - times), left, right)
    hz = frequencies[indices]
    valid = np.isfinite(hz) & (hz > 0) & (confidence[indices] >= 0.75)
    valid &= abs(positions[indices] - times) <= 0.025
    valid &= np.array([points[i].audio_active is True for i in indices])
    notes = 69 + 12 * np.log2(np.maximum(np.nan_to_num(hz), 1) / 440)
    return notes, valid


def _pitch_curve(
    render: PitchRender, actual: Sequence[PitchPoint], reference: Sequence[PitchPoint]
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    times = np.arange(math.ceil(render.info.duration * 100)) * 0.01
    source, trusted, _ = mapped_reference_times(
        times, render.adjustments, render.offset_result, render.reference_origin
    )
    voice, voiced = _sample_notes(actual, times)
    target, expected = _sample_notes(reference, source)
    eligible = voiced & expected & trusted
    key_shift = np.zeros(len(times))
    for adjustment in parse_playback_adjustments(render.pitch_adjustments):
        key_shift[times >= adjustment.elapsed_seconds] = adjustment.key_shift
        eligible &= abs(times - adjustment.elapsed_seconds) > 0.15
    target += key_shift
    # Assign the reference melody to the nearest octave of this performance.
    error = voice - target
    error -= 12 * np.round(error / 12)
    eligible &= abs(error) < 2.5
    eligible = minimum_filter1d(eligible.astype(float), size=9, mode="constant") > 0
    # Correct sustained note drift without following syllables or natural vibrato.
    correction = np.where(eligible, np.clip(-0.6 * error, -0.75, 0.75), 0.0)
    correction = gaussian_filter1d(median_filter(correction, size=31), sigma=8)
    return times, correction, voice, target, eligible


def _render_correction(render: PitchRender, times: np.ndarray, correction: np.ndarray) -> Path:
    commands = render.work / "pitch-commands.txt"
    target = render.work / "tuned-voice.wav"
    # Escape both the filter option and filtergraph layers, including Windows drives.
    value = "".join("\\" + c if c in "\\':" else c for c in commands.as_posix())
    escaped = "".join("\\" + c if c in "\\'[],;" else c for c in value)
    try:
        with commands.open("w", encoding="utf-8") as output:
            for index in range(len(times)):
                _check_cancel(render.cancel)
                ratio = 2 ** (correction[index] / 12)
                output.write(f"{times[index]:.3f} rubberband@tune pitch {ratio:.9f};\n")
        graph = (
            f"[0:a]asendcmd=f={escaped},rubberband@tune=tempo=1:pitch=1:"
            "formant=preserved:pitchq=consistency:transients=smooth:channels=together,"
            f"apad,atrim=end_sample={render.info.frames}[out]"
        )
        render.renderer._mix(
            render.vocal, render.vocal, graph, ["-c:a", "pcm_f32le", str(target)], render.cancel
        )
        _preserve_pitch_intervals(render, target, times, correction)
        return target
    finally:
        commands.unlink(missing_ok=True)


def _preserve_pitch_intervals(
    render: PitchRender, target: Path, times: np.ndarray, correction: np.ndarray
) -> None:
    # A unity pitch ratio still resynthesizes the signal. Keep the original
    # consonants, rests and in-tune phrases, fading in only real corrections.
    preserved = render.work / "pitch-selective.wav"
    with (
        sf.SoundFile(render.vocal) as dry,
        sf.SoundFile(target) as wet,
        _temporary_wave(preserved, samplerate=dry.samplerate, channels=dry.channels) as output,
    ):
        offset = 0
        # Crossfade at note boundaries, not for the duration of a pitch ramp:
        # partially mixing phase-shifted voices can cancel a whole syllable.
        weights = (np.abs(correction) > 0.1).astype(float)
        for original in dry.blocks(blocksize=65536, dtype="float32", always_2d=True):
            _check_cancel(render.cancel)
            shifted = wet.read(len(original), dtype="float32", always_2d=True)
            positions = (offset + np.arange(len(original))) / dry.samplerate
            amount = np.interp(positions, times, weights)[:, None]
            output.write(original + amount * (shifted - original))
            offset += len(original)
    preserved.replace(target)


def _pitch_improvement(
    candidate: Sequence[PitchPoint],
    times: np.ndarray,
    voice: np.ndarray,
    target: np.ndarray,
    eligible: np.ndarray,
) -> dict[str, object]:
    notes, confident = _sample_notes(candidate, times)
    matched = eligible & confident
    if np.count_nonzero(matched) < max(30, np.count_nonzero(eligible) * 0.8):
        return {"accepted": False, "reason": "insufficient-output-confidence"}
    before, after = voice[matched] - target[matched], notes[matched] - target[matched]
    before = abs(before - 12 * np.round(before / 12))
    after = abs(after - 12 * np.round(after / 12))
    octave_changes = float(np.mean(abs(notes[matched] - voice[matched]) > 6))
    accepted = bool(
        np.median(after) <= np.median(before)
        and np.mean(after) < np.mean(before)
        and octave_changes <= 0.01
    )
    return {
        "accepted": accepted,
        "comparedSeconds": np.count_nonzero(matched) * 0.01,
        "beforeMedianSemitones": float(np.median(before)),
        "afterMedianSemitones": float(np.median(after)),
        "beforeMeanSemitones": float(np.mean(before)),
        "afterMeanSemitones": float(np.mean(after)),
        "octaveChangeFraction": octave_changes,
    }


def _normalize_pitch(render: PitchRender, candidate: Path) -> float:
    levels = [_profile(path, render.cancel, voice_band=True) for path in (render.vocal, candidate)]
    energy = [float(np.mean(10 ** (level / 10))) for level in levels]
    gain = float(np.clip(10 * math.log10(max(energy[0], 1e-12) / max(energy[1], 1e-12)), -3, 3))
    target = render.work / "pitch-balanced.wav"
    render.renderer._mix(
        candidate,
        candidate,
        f"[0:a]volume={gain:.9f}dB[out]",
        ["-c:a", "pcm_f32le", str(target)],
        render.cancel,
    )
    inspect_master(
        target,
        expected_frames=render.info.frames,
        expected_rate=render.info.samplerate,
        expected_channels=render.output_channels,
    )
    render.vocal = target
    render.voice_db = _profile(target, render.cancel)
    render.gains = np.zeros_like(render.voice_db)
    render.reliable = render.voice_db > max(-80.0, float(np.percentile(render.voice_db, 80)) - 24)
    return gain


def apply_reference_pitch(render: PitchRender) -> dict[str, object]:
    if render.pitch is None or not render.timing_known or not render.reliable.any():
        return {"applied": False, "method": "unavailable-or-unconfirmed-pitch-timeline"}
    _check_cancel(render.cancel)
    if render.progress:
        render.progress("PitchAnalysis", 0.0, 0.66)
    actual = render.pitch(render.vocal)
    if render.progress:
        render.progress("ReferencePitchAnalysis", 0.0, 0.69)
    reference = render.pitch(render.reference_vocal)
    times, correction, voice, target, eligible = _pitch_curve(render, actual, reference)
    corrected = int(np.count_nonzero(abs(correction) > 0.1))
    if corrected < 30:
        return {"applied": False, "method": "no-confident-pitch-correction"}
    candidate = _render_correction(render, times, correction)
    try:
        verification = _pitch_improvement(render.pitch(candidate), times, voice, target, eligible)
        accepted = bool(verification["accepted"])
        gain = _normalize_pitch(render, candidate) if accepted else 0.0
        return {
            "applied": accepted,
            "method": "soft-reference-pitch-nearest-octave",
            "limitSemitones": 0.75,
            "correctedSeconds": corrected * 0.01,
            "normalizationGainDb": gain,
            "verification": verification,
        }
    finally:
        candidate.unlink(missing_ok=True)
