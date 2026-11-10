"""Streaming post-render audit; never changes audio or the chosen mastering gains."""
from __future__ import annotations

from pathlib import Path
import numpy as np
import soundfile as sf


def _mono(samples: np.ndarray) -> np.ndarray:
    return np.mean(samples.astype(np.float64), axis=1) if samples.ndim == 2 else samples.astype(np.float64)


def audit_mix(vocal: Path, backing: Path, master: Path, *, block_frames: int = 16384) -> dict[str, object]:
    """Compare actual stem energy and output, including active-vocal time windows.

    The mix contains nonlinear limiting, so stem ratios are *pre-limiter* diagnostics,
    not a claim that the final vocal can be perfectly isolated from the master.
    """
    with sf.SoundFile(vocal) as v, sf.SoundFile(backing) as b, sf.SoundFile(master) as m:
        if len({v.samplerate, b.samplerate, m.samplerate}) != 1 or len({v.frames, b.frames, m.frames}) != 1:
            return {"status": "incompatible-stems", "note": "Sample rates or lengths differ"}
        frames = []
        peak = 0.0
        while True:
            vs, bs, ms = (f.read(block_frames, dtype="float32", always_2d=True) for f in (v, b, m))
            if not len(vs):
                break
            if len(vs) != len(bs) or len(vs) != len(ms):
                return {"status": "incompatible-stems"}
            x, y = _mono(vs), _mono(bs)
            peak = max(peak, float(np.max(np.abs(ms))))
            frames.append((float(np.mean(x*x)), float(np.mean(y*y))))
    if not frames:
        return {"status": "empty"}
    powers = np.asarray(frames)
    voice_power = powers[:, 0]
    backing_power = powers[:, 1]
    active = voice_power > max(float(np.percentile(voice_power, 80)) * 0.15, 1e-10)
    if not np.any(active):
        return {"status": "no-active-vocal", "outputSamplePeakDbfs": round(float(20*np.log10(max(peak, 1e-12))), 2)}
    ratios = 10*np.log10(np.maximum(voice_power[active], 1e-12)/np.maximum(backing_power[active], 1e-12))
    return {
        "status": "measured",
        "method": "pre-limiter-active-stem-energy",
        "activeBlocks": int(np.sum(active)),
        "vocalToBackingMedianDb": round(float(np.median(ratios)), 2),
        "vocalToBackingP10Db": round(float(np.percentile(ratios, 10)), 2),
        "vocalToBackingP90Db": round(float(np.percentile(ratios, 90)), 2),
        "outputSamplePeakDbfs": round(float(20*np.log10(max(peak, 1e-12))), 2),
        "note": "Energy ratios do not measure perceptual masking or isolate post-limiter vocals",
    }
