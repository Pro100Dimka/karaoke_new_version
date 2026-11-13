"""Bounded-memory checks of a rendered Studio Master (no source mutation)."""

from __future__ import annotations

from pathlib import Path
import math
import numpy as np
import soundfile as sf

from backend.domain_errors import DependencyError


def inspect_master(
    path: Path,
    *,
    expected_frames: int,
    expected_rate: int,
    expected_channels: int,
    blocksize: int = 65536,
) -> dict[str, object]:
    """Stream the final PCM to detect corrupt, silent or clipped output.

    Peak and RMS are sample-domain metrics; they do not claim true-peak/LUFS accuracy.
    """
    with sf.SoundFile(path) as source:
        if (source.frames, source.samplerate, source.channels) != (
            expected_frames,
            expected_rate,
            expected_channels,
        ):
            raise DependencyError(
                "StudioMasterInvalidAudio", "Master audio format or duration changed"
            )
        peak, energy, samples, clipped = 0.0, 0.0, 0, 0
        for block in source.blocks(blocksize=blocksize, dtype="float32", always_2d=True):
            if not np.isfinite(block).all():
                raise DependencyError(
                    "StudioMasterInvalidAudio", "Master contains non-finite samples"
                )
            absolute = np.abs(block)
            peak = max(peak, float(absolute.max(initial=0)))
            energy += float(np.sum(np.square(block.astype(np.float64))))
            samples += block.size
            clipped += int(np.count_nonzero(absolute >= 0.999))
    rms = math.sqrt(energy / max(samples, 1))
    if samples == 0 or rms < 1e-7:
        raise DependencyError("StudioMasterInvalidAudio", "Master is empty or effectively silent")
    return _quality_report(peak, rms, clipped, samples, expected_channels, expected_rate)


def _quality_report(
    peak: float, rms: float, clipped: int, samples: int, expected_channels: int, expected_rate: int
) -> dict[str, object]:
    return {
        "samplePeakDbfs": round(20 * math.log10(max(peak, 1e-12)), 2),
        "rmsDbfs": round(20 * math.log10(rms), 2),
        "clippedSamples": clipped,
        "clippedFraction": round(clipped / samples, 8),
        "channels": expected_channels,
        "sampleRate": expected_rate,
        "verified": True,
        "note": "Sample-domain QC; not a true-peak or perceptual quality measurement",
    }
