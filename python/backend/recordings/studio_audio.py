from __future__ import annotations
from typing import Protocol
from contextlib import contextmanager
from collections.abc import Iterator
from backend.infrastructure.process_runner import ProcessResult
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
import threading
import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.paths import ensure_within

_PROFILE_SECONDS = 0.1


_MAX_BOOST_DB = 9.0
_VOCAL_TARGET_OFFSET_DB = -3.5


class _ScratchWave(sf.SoundFile):
    def write(self, data: object) -> None:
        if isinstance(data, np.ndarray) and data.dtype == np.float64:
            # Match FLOAT encoding's rounding before its slower native double conversion.
            with np.errstate(all="ignore"):
                data = data.astype(np.float32)
        super().write(data)

    def flush(self) -> None:
        # sf_close still finalizes the WAV header and closes the native handle.
        # These owned, disposable intermediates need no sf_write_sync/fsync.
        # Native I/O also avoids a Python callback for every libsndfile write.
        self._check_if_closed()


@contextmanager
def _temporary_wave(path: Path, *, samplerate: int, channels: int) -> Iterator[sf.SoundFile]:
    """Close scratch PCM before reuse without forcing a disk durability flush per stage."""
    with _ScratchWave(
        path, "w", samplerate=samplerate, channels=channels, subtype="FLOAT", format="WAV"
    ) as output:
        yield output


def _write_gain_envelope(
    source: Path,
    target: Path,
    times: NDArray[np.floating],
    gains: NDArray[np.float64],
    cancel: threading.Event,
) -> None:
    with (
        sf.SoundFile(source) as original,
        _temporary_wave(
            target, samplerate=original.samplerate, channels=original.channels
        ) as output,
    ):
        offset = 0
        for samples in original.blocks(blocksize=65536, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            positions = (offset + np.arange(len(samples))) / original.samplerate
            gain = np.power(10.0, np.interp(positions, times, gains) / 20)
            output.write(samples * gain[:, None])
            offset += len(samples)


@dataclass(frozen=True, slots=True)
class StudioMasterBalance:
    vocal_gain_db: float
    user_vocal_db: float
    performance_instrumental_db: float
    reference_vocal_db: float
    original_instrumental_db: float
    matched_fraction: float
    processing: Mapping[str, object] = field(default_factory=dict)

    def payload(self) -> dict[str, object]:
        gain_plan = self.processing.get("gainPlan")
        limit = gain_plan.get("maxBoostDb") if isinstance(gain_plan, Mapping) else None
        max_boost = float(limit) if isinstance(limit, (int, float)) else _MAX_BOOST_DB
        return {
            "vocalGainDb": self.vocal_gain_db,
            "userVocalDb": self.user_vocal_db,
            "performanceInstrumentalDb": self.performance_instrumental_db,
            "referenceVocalDb": self.reference_vocal_db,
            "originalInstrumentalDb": self.original_instrumental_db,
            "levelMeasure": "rmsDbfs",
            "matchedFraction": self.matched_fraction,
            "maxBoostDb": max_boost,
            "processing": dict(self.processing),
        }


def recording_stems(path: Path, *, prefer_dry: bool = False) -> tuple[Path, Path] | None:
    # The mix can be archived separately; native stems retain their original basename.
    voices = (".dry.wav", ".dry.flac", ".vocal.wav") if prefer_dry else (".vocal.wav",)
    for source in dict.fromkeys((path, path.with_suffix(".wav"))):
        backing = ensure_within(Path(str(source) + ".backing.wav"), path.parent)
        if not backing.is_file():
            continue
        for suffix in voices:
            voice = ensure_within(Path(str(source) + suffix), path.parent)
            if not voice.is_file():
                continue
            info = sf.info(path)
            for stem in (voice, backing):
                other = sf.info(stem)
                if (other.frames, other.samplerate, other.channels) != (
                    info.frames,
                    info.samplerate,
                    info.channels,
                ):
                    raise DependencyError(
                        "StudioMasterInvalidStems", "Recording stems are not synchronized"
                    )
            return voice, backing
    return None


def recoverable_recording_sources(path: Path) -> tuple[Path, Path, Path] | None:
    """Resolve untouched audio separately from companions that retain the native basename."""
    for native in dict.fromkeys((path, path.with_suffix(".wav"))):
        backing = ensure_within(Path(str(native) + ".backing.wav"), path.parent)
        vocal = ensure_within(Path(str(native) + ".vocal.wav"), path.parent)
        if not backing.is_file() or vocal.is_file():
            continue
        original = ensure_within(path.with_name(f"{path.stem}.original.wav"), path.parent)
        source = original if original.is_file() else path
        inputs = (sf.info(source), sf.info(backing))
        if any(
            info.format not in {"WAV", "WAVEX", "RF64", "FLAC"}
            or info.subtype not in {"PCM_U8", "PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"}
            for info in inputs
        ):
            # A lossy listening copy cannot recover the original microphone by subtraction.
            return None
        shapes = {
            (info.frames, info.samplerate, info.channels) for info in (*inputs, sf.info(path))
        }
        if len(shapes) != 1 or inputs[0].frames <= 0:
            raise DependencyError(
                "StudioMasterInvalidStems", "Recording stems are not synchronized"
            )
        return source, backing, vocal
    return None


def _check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise DomainError("ProcessCancelled", "Studio master was cancelled", 499)


def _profile(
    path: Path,
    cancel: threading.Event,
    *,
    voice_band: bool = False,
    frame_seconds: float = _PROFILE_SECONDS,
    band_hz: tuple[float, float] = (300.0, 3500.0),
    center: bool = False,
) -> NDArray[np.float64]:
    levels: list[float] = []
    with sf.SoundFile(path) as source:
        frame_size = max(1, round(source.samplerate * frame_seconds))
        for samples in source.blocks(
            blocksize=frame_size * 32,
            dtype="float64",
            always_2d=True,
        ):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            if center:
                samples = samples.mean(axis=1, keepdims=True)
            complete = len(samples) // frame_size * frame_size
            # Keep the final partial window's own length and taper unchanged.
            for frames in (
                samples[:complete].reshape(-1, frame_size, samples.shape[1]),
                samples[complete:][None, :, :],
            ):
                if not frames.size:
                    continue
                power = np.mean(frames * frames, axis=(1, 2))
                if voice_band:
                    power = _band_power(frames, source.samplerate, band_hz)
                levels.extend((10 * np.log10(np.maximum(1e-12, power))).tolist())
    if not levels:
        raise DependencyError("StudioMasterSilentTrack", "Recording contains no audio")
    return np.asarray(levels, dtype=np.float64)


def _band_power(
    frames: NDArray[np.float64], samplerate: int, band_hz: tuple[float, float]
) -> NDArray[np.float64]:
    length = frames.shape[1]
    window = np.hanning(length)[None, :, None]
    spectrum = np.fft.rfft(frames * window, axis=1)
    hz = np.fft.rfftfreq(length, 1 / samplerate)
    low, high = band_hz
    power = 2 * np.sum(np.abs(spectrum[:, (hz >= low) & (hz <= high)]) ** 2, axis=(1, 2))
    result: NDArray[np.float64] = power / max(
        1.0, length * float(np.sum(window**2)) * frames.shape[2]
    )
    return result


class MasterRenderer(Protocol):
    def _mix(
        self,
        first: Path,
        second: Path,
        filter_graph: str,
        output: list[str],
        cancel: threading.Event,
        *,
        quiet: bool = True,
    ) -> ProcessResult: ...

    def _balance_curve(
        self,
        voice: NDArray[np.float64],
        backing: NDArray[np.float64],
    ) -> tuple[NDArray[np.float64], NDArray[np.bool_]]: ...

    def _voice_filters(
        self,
        path: Path,
        levels: NDArray[np.float64],
        cancel: threading.Event,
        reference: Path | None = None,
    ) -> tuple[list[str], dict[str, object]]: ...

    def _repeated_output_channels(self, path: Path, cancel: threading.Event) -> bool: ...

    def _unmask_backing(
        self,
        backing: Path,
        voice: Path,
        target: Path,
        active: NDArray[np.bool_],
        cancel: threading.Event,
        reference_vocal: Path | None = None,
        reference_backing: Path | None = None,
    ) -> dict[str, object]: ...

    def _reference_offset(
        self, backing: Path, original: Path, origin: float | None, cancel: threading.Event
    ) -> tuple[float, float]: ...
