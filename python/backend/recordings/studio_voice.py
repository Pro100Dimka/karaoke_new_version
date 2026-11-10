from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
import math
import threading
import numpy as np
import soundfile as sf
from numpy.typing import NDArray
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_dynamics import _reference_compression


@dataclass(slots=True)
class VoicePreparation:
    renderer: MasterRenderer
    user_vocal: Path
    backing: Path
    reference_vocal: Path
    target: Path
    info: sf._SoundFileInfo
    output_channels: int
    cancel: threading.Event
    processing: dict[str, object] = field(init=False)

    def run(
        self, raw_profile: NDArray[np.float64], reference_levels: NDArray[np.float64]
    ) -> dict[str, object]:
        active = raw_profile[raw_profile > max(-80.0, float(np.max(raw_profile)) - 35)]
        if active.size == 0:
            raise DependencyError("StudioMasterSilentTrack", "No audible recorded voice")
        dynamics = _reference_compression(raw_profile, reference_levels)
        ratio = float(dynamics["ratio"])
        threshold = float(np.clip(10 ** (float(dynamics["thresholdDb"]) / 20), 0.001, 1))
        self.processing = {"referenceCompression": dynamics}
        filters, analysis = self.renderer._voice_filters(
            self.user_vocal, raw_profile, self.cancel, self.reference_vocal
        )
        self.processing.update(
            compressorRatio=ratio,
            compressorThresholdDb=20 * math.log10(threshold),
            voiceAnalysis=analysis,
            compressorMix=1.0,
        )
        if ratio > 1.01:
            filters.append(
                f"acompressor=threshold={threshold:.9f}:ratio={ratio:.6f}:"
                f"attack={float(dynamics['attackMs']):.3f}:release={float(dynamics['releaseMs']):.3f}:"
                "makeup=1:mix=1:link=maximum:detection=rms"
            )
        filters.extend(
            (
                f"aresample={self.info.samplerate}",
                "apad",
                f"atrim=end_sample={self.info.frames}",
            )
        )
        self.renderer._mix(
            self.user_vocal,
            self.backing,
            "[0:a]" + ",".join(filters) + "[out]",
            ["-ac", str(self.output_channels), "-c:a", "pcm_f32le", str(self.target)],
            self.cancel,
        )
        return self.processing
