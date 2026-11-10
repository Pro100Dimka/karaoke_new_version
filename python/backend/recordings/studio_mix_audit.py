"""Streaming post-mix measurements; diagnostic only, never modifies audio."""
from __future__ import annotations

from pathlib import Path
import math
import numpy as np
import soundfile as sf


def audit_mix(vocal: Path, backing: Path, master: Path, *, vocal_gain_db: float = 0.0, block_frames: int = 16384) -> dict[str, object]:
    """Compare source contributions and actual output, including limiter effects.

    Stereo powers are measured per channel, avoiding mono cancellation.  The
    output comparison is only valid when the stems and master have matching
    channel layouts; otherwise report the limitation rather than guessing.
    """
    if not math.isfinite(vocal_gain_db):
        raise ValueError("vocal_gain_db must be finite")
    vocal_gain = 10.0 ** (vocal_gain_db / 20.0)
    if block_frames < 512:
        raise ValueError("block_frames must be at least 512")
    with sf.SoundFile(vocal) as v, sf.SoundFile(backing) as b, sf.SoundFile(master) as m:
        if len({v.samplerate, b.samplerate, m.samplerate}) != 1 or len({v.frames, b.frames, m.frames}) != 1:
            return {"status": "incompatible-stems", "note": "Sample rates or lengths differ"}
        if v.channels != b.channels or v.channels != m.channels:
            return {"status": "incompatible-channels", "channels": [v.channels, b.channels, m.channels]}
        sr = v.samplerate
        freqs = np.fft.rfftfreq(block_frames, 1 / sr)
        band = (freqs >= 300) & (freqs <= min(3500, sr / 2))
        window = np.hanning(block_frames)[:, None]
        rows = []
        peak = 0.0
        for vs in v.blocks(blocksize=block_frames, dtype="float32", always_2d=True):
            bs = b.read(len(vs), dtype="float32", always_2d=True)
            ms = m.read(len(vs), dtype="float32", always_2d=True)
            if len(bs) != len(vs) or len(ms) != len(vs):
                return {"status": "incompatible-stems"}
            x, y, z = (a.astype(np.float64) for a in (vs, bs, ms))
            x *= vocal_gain
            peak = max(peak, float(np.max(np.abs(z))))
            vp, bp = float(np.mean(x*x)), float(np.mean(y*y))
            # FFT per channel; do not cancel stereo out-of-phase energy.
            if len(x) < block_frames:
                x = np.pad(x, ((0, block_frames-len(x)), (0, 0)))
                y = np.pad(y, ((0, block_frames-len(y)), (0, 0)))
            xf, yf = np.fft.rfft(x*window, axis=0), np.fft.rfft(y*window, axis=0)
            # Normalized difference between the pre-limiter sum and actual output.
            predicted = x[:len(vs)] + y[:len(vs)]
            difference = ms.astype(np.float64) - predicted
            residual = float(np.mean(difference*difference))
            predicted_power = float(np.mean(predicted*predicted))
            # The residual is measured on the actual encoded output, not inferred
            # from the limiter settings. This also detects unexpectedly changed
            # delivery routing and vocal gain.
            rows.append((vp, bp, float(np.sum(np.abs(xf[band])**2)),
                         float(np.sum(np.abs(yf[band])**2)), residual, predicted_power,
                         float(np.mean(z*z)), float(np.mean(z*predicted))))
    if not rows:
        return {"status": "empty"}
    p = np.asarray(rows)
    active = p[:, 0] > max(float(np.percentile(p[:, 0], 80)) * 0.15, 1e-10)
    if not np.any(active):
        return {"status": "no-active-vocal", "outputSamplePeakDbfs": round(float(20*np.log10(max(peak, 1e-12))), 2)}
    ratios = 10*np.log10(np.maximum(p[active, 0], 1e-12)/np.maximum(p[active, 1], 1e-12))
    spectral = 10*np.log10(np.maximum(p[active, 2], 1e-12)/np.maximum(p[active, 3], 1e-12))
    # Least-squares gain of the delivered master against the pre-limiter mix.
    # A negative value can reveal unintended global attenuation. It is not
    # interpreted as vocal-specific attenuation, which cannot be recovered
    # uniquely from a stereo master.
    delivered_gain = np.maximum(p[active, 7], 0) / np.maximum(p[active, 5], 1e-16)
    delivered_gain_db = 20*np.log10(np.maximum(delivered_gain, 1e-12))
    residual_db = 10*np.log10(np.maximum(p[active, 4], 1e-16)/np.maximum(p[active, 5], 1e-16))
    return {
        "status": "measured",
        "method": "active-stereo-stem-power-and-output-residual",
        "deliveryVocalGainDb": round(vocal_gain_db, 3),
        "activeBlocks": int(np.sum(active)),
        "vocalToBackingMedianDb": round(float(np.median(ratios)), 2),
        "vocalToBackingP10Db": round(float(np.percentile(ratios, 10)), 2),
        "vocalToBackingP90Db": round(float(np.percentile(ratios, 90)), 2),
        "voiceBandHz": [300, int(min(3500, sr/2))],
        "voiceBandVocalToBackingMedianDb": round(float(np.median(spectral)), 2),
        "voiceBandVocalToBackingP10Db": round(float(np.percentile(spectral, 10)), 2),
        "voiceBandBackingDominantFraction": round(float(np.mean(spectral < 0)), 3),
        "deliveredMixGainMedianDb": round(float(np.median(delivered_gain_db)), 2),
        "deliveredMixGainP10Db": round(float(np.percentile(delivered_gain_db, 10)), 2),
        "outputVsStemSumResidualMedianDb": round(float(np.median(residual_db)), 2),
        "outputSamplePeakDbfs": round(float(20*np.log10(max(peak, 1e-12))), 2),
        "note": "Residual includes limiter, quantization, and any other delivery processing; not a vocal-only masking metric",
    }


def reference_voice_band_balance(vocal: Path, backing: Path, *, block_frames: int = 16384) -> float | None:
    """Measure median active-voice band prominence, independently of song duration.

    Both files must be stems from the same song. No fixed target prominence is used.
    """
    with sf.SoundFile(vocal) as v, sf.SoundFile(backing) as b:
        if v.samplerate != b.samplerate or v.frames != b.frames:
            return None
        sr = v.samplerate
        freqs = np.fft.rfftfreq(block_frames, 1 / sr)
        band = (freqs >= 300) & (freqs <= min(3500, sr / 2))
        window = np.hanning(block_frames)
        powers = []
        while True:
            vs = v.read(block_frames, dtype="float32", always_2d=True)
            bs = b.read(block_frames, dtype="float32", always_2d=True)
            if not len(vs):
                break
            if len(vs) != len(bs):
                return None
            # Channel power, not mono cancellation, determines vocal activity.
            activity = float(np.mean(vs.astype(np.float64) ** 2))
            x = np.mean(vs, axis=1)
            y = np.mean(bs, axis=1)
            if len(x) < block_frames:
                x = np.pad(x, (0, block_frames - len(x)))
                y = np.pad(y, (0, block_frames - len(y)))
            xf, yf = np.fft.rfft(x * window), np.fft.rfft(y * window)
            powers.append((activity, float(np.sum(np.abs(xf[band]) ** 2)),
                           float(np.sum(np.abs(yf[band]) ** 2))))
    if len(powers) < 3:
        return None
    p = np.asarray(powers)
    active = p[:, 0] > max(float(np.percentile(p[:, 0], 80)) * 0.15, 1e-10)
    if np.count_nonzero(active) < 3:
        return None
    ratio = 10 * np.log10(np.maximum(p[active, 1], 1e-12) / np.maximum(p[active, 2], 1e-12))
    return float(np.median(ratio))
