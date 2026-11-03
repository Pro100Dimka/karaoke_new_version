from __future__ import annotations
from typing import Protocol
from backend.infrastructure.process_runner import ProcessResult
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
import math
import threading
import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.paths import ensure_within

_PROFILE_SECONDS = 0.1


_MAX_BOOST_DB = 9.0


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
        return {
            "vocalGainDb": self.vocal_gain_db,
            "userVocalDb": self.user_vocal_db,
            "performanceInstrumentalDb": self.performance_instrumental_db,
            "referenceVocalDb": self.reference_vocal_db,
            "originalInstrumentalDb": self.original_instrumental_db,
            "levelMeasure": "rmsDbfs",
            "matchedFraction": self.matched_fraction,
            "maxBoostDb": _MAX_BOOST_DB,
            "processing": dict(self.processing),
        }


def recording_stems(path: Path, *, prefer_dry: bool = False) -> tuple[Path, Path] | None:
    dry = ensure_within(Path(str(path) + ".dry.wav"), path.parent)
    voice_suffix = ".dry.wav" if prefer_dry and dry.is_file() else ".vocal.wav"
    stems = tuple(
        ensure_within(Path(str(path) + suffix), path.parent)
        for suffix in (voice_suffix, ".backing.wav")
    )
    if not all(stem.is_file() for stem in stems):
        return None
    info = sf.info(path)
    for stem in stems:
        other = sf.info(stem)
        if (other.frames, other.samplerate, other.channels) != (
            info.frames,
            info.samplerate,
            info.channels,
        ):
            raise DependencyError(
                "StudioMasterInvalidStems", "Recording stems are not synchronized"
            )
    return stems[0], stems[1]


def _check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise DomainError("ProcessCancelled", "Studio master was cancelled", 499)


def _profile(path: Path, cancel: threading.Event) -> NDArray[np.float64]:
    levels: list[float] = []
    with sf.SoundFile(path) as source:
        for samples in source.blocks(
            blocksize=round(source.samplerate * _PROFILE_SECONDS), dtype="float64", always_2d=True
        ):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            levels.append(10 * math.log10(max(1e-12, float(np.mean(samples * samples)))))
    if not levels:
        raise DependencyError("StudioMasterSilentTrack", "Recording contains no audio")
    return np.asarray(levels, dtype=np.float64)


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
        reference: NDArray[np.float64],
        original: NDArray[np.float64],
        *,
        phrase_smoothing: bool = False,
    ) -> tuple[NDArray[np.float64], NDArray[np.bool_]]: ...

    def _voice_filters(
        self, path: Path, levels: NDArray[np.float64], cancel: threading.Event
    ) -> tuple[list[str], dict[str, object]]: ...

    def _repeated_output_channels(self, path: Path, cancel: threading.Event) -> bool: ...

    def _unmask_backing(
        self,
        backing: Path,
        voice: Path,
        target: Path,
        active: NDArray[np.bool_],
        cancel: threading.Event,
    ) -> dict[str, object]: ...

    def _reference_offset(
        self, backing: Path, original: Path, origin: float | None, cancel: threading.Event
    ) -> tuple[float, float]: ...
