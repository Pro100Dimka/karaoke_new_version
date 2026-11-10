from __future__ import annotations
from numpy.typing import NDArray
from collections.abc import Callable
from pathlib import Path
import math
import threading
import numpy as np
import soundfile as sf
from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessResult
from backend.infrastructure.ffmpeg_audio import loudnorm_filter, parse_loudness
from backend.recordings.studio_audio import _PROFILE_SECONDS
from dataclasses import dataclass, field
from concurrent.futures import Future
from backend.recordings.studio_audio import MasterRenderer


@dataclass(slots=True)
class MasterDelivery:
    renderer: MasterRenderer
    backing: Path
    balanced: Path
    target: Path
    cancel: threading.Event
    info: sf._SoundFileInfo
    output_channels: int
    process_voice: bool
    match_recording_loudness: bool
    recording_analysis: Future[ProcessResult] | None
    peak_bound: float
    reliable: NDArray[np.bool_]
    processing: dict[str, object]
    progress: Callable[[str, float, float], None] | None
    voice_gain_db: float = 0
    measured: dict[str, float] | None = field(init=False)
    ceiling: float = field(init=False)
    target_lufs: float = field(init=False)
    gain: float = field(init=False)
    unity_candidate: bool = field(init=False)
    final_levels: dict[str, float] | None = field(init=False)
    graph: str = field(init=False)

    def run(self) -> None:
        voice = "[1:a]"
        self.graph = ""
        if self.voice_gain_db:
            self.graph = f"[1:a]volume={self.voice_gain_db:.9f}dB[voice];"
            voice = "[voice]"
        self.graph += f"[0:a]{voice}amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
        if self.process_voice:
            # A limiter acts only on peaks, unlike a global gain reduction that
            # makes the entire accompaniment quieter throughout the song.
            self.graph += "alimiter=limit=0.891251:attack=5:release=80:level=0,"
            self.gain = 0.0
            self.renderer._mix(
                self.backing, self.balanced,
                self.graph + "anull[out]",
                ["-ar", str(self.info.samplerate), "-ac", str(self.output_channels),
                 "-c:a", "pcm_s24le", str(self.target)],
                self.cancel,
            )
            self.processing["delivery"] = {
                "method": "peak-limited-unity-backing",
                "globalGainDb": 0.0,
                "limiterCeilingDbfs": -1.0,
                "note": "Limiter reduces only peaks; overlapping peaks may affect accompaniment",
            }
        else:
            self._measure_delivery()
            self._write_delivery()

    def _measure_delivery(self) -> None:
        if self.progress:
            self.progress("AnalyzingBalance", 1.0, 0.78)
        # A unity-gain original needs no preliminary loudness scan if its samples cannot
        # clip. Always meter the encoded samples; intersample overshoots still trigger attenuation.
        self.unity_candidate = (
            not self.process_voice and not self.match_recording_loudness and self.peak_bound < 0.95
        )
        self.measured = None
        self.ceiling = -1.0 if self.process_voice else -3.0
        self.target_lufs, self.gain = 0.0, 0.0
        if not self.unity_candidate:
            analysis = self.renderer._mix(
                self.backing,
                self.balanced,
                self.graph + loudnorm_filter(lra=11) + "[out]",
                ["-f", "null", "-"],
                self.cancel,
                quiet=False,
            )
            self.measured = parse_loudness(analysis.stderr)
            if self.measured is None or not all(
                math.isfinite(value) for value in self.measured.values()
            ):
                raise DependencyError(
                    "StudioMasterFailed", "Studio master loudness analysis failed"
                )
            self.target_lufs = -14.0 if self.process_voice else self.measured["input_i"]
            self._match_loudness()
            self.gain = min(
                self.target_lufs - self.measured["input_i"],
                self.ceiling - 0.05 - self.measured["input_tp"],
            )
            if self.process_voice and np.count_nonzero(self.reliable) * _PROFILE_SECONDS < 3:
                self.gain = min(self.gain, 0.0)

    def _write_delivery(self) -> None:
        if self.progress:
            self.progress("AnalyzingBalance", 1.0, 0.85)
        self.final_levels = None
        for attempt in range(2):
            self.final_levels = self._encode_verified()
            if self.measured is None:
                self.measured = self.final_levels
                self.target_lufs = self.measured["input_i"]
            peak_limit = (
                self.ceiling - 0.05 if self.unity_candidate and attempt == 0 else self.ceiling
            )
            if (
                self.final_levels["input_tp"] <= peak_limit
                and self.final_levels["input_i"] <= self.target_lufs + 0.2
            ):
                break
            if attempt == 1:
                raise DependencyError(
                    "StudioMasterFailed", "Final master exceeds its loudness or peak ceiling"
                )
            # Re-render from float stems, never repeatedly quantize the published result.
            self.gain += min(
                0.0,
                self.ceiling - 0.05 - self.final_levels["input_tp"],
                self.target_lufs - self.final_levels["input_i"],
            )
        if self.final_levels is not None and self.measured is not None:
            self.processing["delivery"] = {
                "method": "measured-linear-gain",
                "gainDb": self.gain,
                "targetLufs": self.target_lufs,
                "truePeakCeilingDbtp": self.ceiling,
                "integratedLufs": self.final_levels["input_i"],
                "truePeakDbtp": self.final_levels["input_tp"],
                "loudnessRangeLu": self.final_levels["input_lra"],
                "mixLoudnessRangeLu": self.measured["input_lra"],
                "verified": True,
            }

    def _encode_verified(self) -> dict[str, float]:
        verification = self.renderer._mix(
            self.backing,
            self.balanced,
            self.graph + f"volume={self.gain:.9f}dB[out]",
            [
                "-ar",
                str(self.info.samplerate),
                "-ac",
                str(self.output_channels),
                "-c:a",
                "pcm_s24le",
                str(self.target),
                "-dec",
                "0:0",
                "-filter_complex",
                "[dec:0]" + loudnorm_filter(lra=11) + "[verified]",
                "-map",
                "[verified]",
                "-f",
                "null",
                "-",
            ],
            self.cancel,
            quiet=False,
        )
        self.final_levels = parse_loudness(verification.stderr)
        if self.final_levels is None or not all(
            math.isfinite(v) for v in self.final_levels.values()
        ):
            raise DependencyError(
                "StudioMasterFailed", "Final master loudness could not be verified"
            )
        return self.final_levels

    def _match_loudness(self) -> None:
        assert self.measured is not None
        if self.match_recording_loudness:
            assert self.recording_analysis is not None
            recording_levels = parse_loudness(self.recording_analysis.result().stderr)
            if recording_levels is None or not math.isfinite(recording_levels["input_i"]):
                raise DependencyError(
                    "StudioMasterFailed", "Recording loudness could not be measured"
                )
            self.target_lufs = min(self.measured["input_i"], recording_levels["input_i"])
