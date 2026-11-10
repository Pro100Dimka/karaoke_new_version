"""Streaming diagnostics of vocal presence and spectral masking.

Reports measurements only; does not silently change the master or its gains.
"""
from __future__ import annotations

from pathlib import Path
import numpy as np
import soundfile as sf


def _mono(samples: np.ndarray) -> np.ndarray:
    return samples.astype(np.float64).mean(axis=1)


def audit_mix(vocal: Path, backing: Path, master: Path, *, block_frames: int = 16384) -> dict[str, object]:
    """Measure active-voice energy and voice-band competition before limiting.

    Spectral power ratios are diagnostic proxies, not perceptual masking scores.
    The nonlinear output limiter prevents exact source attribution after mixing.
    """
    with sf.SoundFile(vocal) as v, sf.SoundFile(backing) as b, sf.SoundFile(master) as m:
        if len({v.samplerate, b.samplerate, m.samplerate}) != 1 or len({v.frames, b.frames, m.frames}) != 1:
            return {"status": "incompatible-stems", "note": "Sample rates or lengths differ"}
        if block_frames < 512:
            raise ValueError("block_frames must be at least 512")
        sr = v.samplerate
        freqs = np.fft.rfftfreq(block_frames, 1 / sr)
        band = (freqs >= 300) & (freqs <= min(3500, sr / 2))
        window = np.hanning(block_frames)
        powers: list[tuple[float, float, float, float]] = []
        peak = 0.0
        while True:
            vs, bs, ms = (f.read(block_frames, dtype="float32", always_2d=True) for f in (v, b, m))
            if not len(vs):
                break
            if len(vs) != len(bs) or len(vs) != len(ms):
                return {"status": "incompatible-stems"}
            x, y = _mono(vs), _mono(bs)
            peak = max(peak, float(np.max(np.abs(ms))))
            if len(x) < block_frames:
                x = np.pad(x, (0, block_frames - len(x)))
                y = np.pad(y, (0, block_frames - len(y)))
            xf, yf = np.fft.rfft(x * window), np.fft.rfft(y * window)
            powers.append((float(np.mean(x*x)), float(np.mean(y*y)),
                           float(np.sum(np.abs(xf[band])**2)),
                           float(np.sum(np.abs(yf[band])**2))))
    if not powers:
        return {"status": "empty"}
    p = np.asarray(powers)
    voice_power, backing_power = p[:, 0], p[:, 1]
    active = voice_power > max(float(np.percentile(voice_power, 80)) * 0.15, 1e-10)
    if not np.any(active):
        return {"status": "no-active-vocal", "outputSamplePeakDbfs": round(float(20*np.log10(max(peak, 1e-12))), 2)}
    ratios = 10*np.log10(np.maximum(voice_power[active], 1e-12)/np.maximum(backing_power[active], 1e-12))
    spectral = 10*np.log10(np.maximum(p[active, 2], 1e-12)/np.maximum(p[active, 3], 1e-12))
    return {
        "status": "measured",
        "method": "pre-limiter-active-stem-energy-and-voice-band",
        "activeBlocks": int(np.sum(active)),
        "vocalToBackingMedianDb": round(float(np.median(ratios)), 2),
        "vocalToBackingP10Db": round(float(np.percentile(ratios, 10)), 2),
        "vocalToBackingP90Db": round(float(np.percentile(ratios, 90)), 2),
        "voiceBandHz": [300, int(min(3500, sr / 2))],
        "voiceBandVocalToBackingMedianDb": round(float(np.median(spectral)), 2),
        "voiceBandVocalToBackingP10Db": round(float(np.percentile(spectral, 10)), 2),
        "voiceBandBackingDominantFraction": round(float(np.mean(spectral < 0)), 3),
        "outputSamplePeakDbfs": round(float(20*np.log10(max(peak, 1e-12))), 2),
        "note": "Voice-band ratios are a masking proxy, not measured intelligibility or post-limiter stem separation",
    }
