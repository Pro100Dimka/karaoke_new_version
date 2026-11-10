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
    graph: str = field(init=False)

    def run(self) -> None:
        voice = "[1:a]"
        self.graph = ""
        if self.voice_gain_db:
            self.graph = f"[1:a]volume={self.voice_gain_db:.9f}dB[voice];"
            voice = "[voice]"
        self.graph += f"[0:a]{voice}amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
        # Use the same delivery path for dry and already-processed vocal stems.
        # Loudness normalization of the entire mix changed the accompaniment level
        # whenever an existing-effects vocal was selected.
        self.graph += "alimiter=limit=0.891251:attack=5:release=80:level=0:latency=1,anull[out]"
        self._encode()
        levels = self._verify_peaks()
        self.processing["delivery"] = {
            "method": "peak-limited-unity-backing",
            "globalGainDb": 0.0,
            "gainDb": 0.0,
            "integratedLufs": levels["input_i"] if math.isfinite(levels["input_i"]) else None,
            "truePeakDbtp": levels["input_tp"],
            "loudnessRangeLu": levels["input_lra"],
            "verified": True,
            "limiterCeilingDbfs": -1.0,
            "note": "Same final mix for dry and existing-effects stems; limiter only handles peaks",
        }

    def _encode(self) -> None:
        self.renderer._mix(
            self.backing,
            self.balanced,
            self.graph,
            [
                "-ar",
                str(self.info.samplerate),
                "-ac",
                str(self.output_channels),
                "-c:a",
                "pcm_s24le",
                str(self.target),
            ],
            self.cancel,
        )

    def _verify_peaks(self) -> dict[str, float]:
        limit = 0.891251
        for attempt in range(3):
            measured = self.renderer._mix(
                self.target,
                self.target,
                "[0:a]" + loudnorm_filter(lra=11) + "[out]",
                ["-f", "null", "-"],
                self.cancel,
                quiet=False,
            )
            levels = parse_loudness(measured.stderr)
            if levels is None or not math.isfinite(levels["input_tp"]):
                raise DependencyError(
                    "StudioMasterInvalidAudio", "Master true peak could not be measured"
                )
            if levels["input_tp"] <= -1.0:
                return levels
            if attempt < 2:
                previous = limit
                limit *= 10 ** ((-1.1 - levels["input_tp"]) / 20)
                self.graph = self.graph.replace(f"limit={previous:.6f}", f"limit={limit:.6f}")
                self._encode()
        raise DependencyError("StudioMasterInvalidAudio", "Master exceeds the true-peak ceiling")
