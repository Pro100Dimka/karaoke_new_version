"""Streaming post-mix measurements; diagnostic only, never modifies audio."""

from __future__ import annotations

from pathlib import Path
import math
import numpy as np
import soundfile as sf


def audit_mix(
    vocal: Path,
    backing: Path,
    master: Path,
    *,
    vocal_gain_db: float = 0.0,
    block_frames: int = 16384,
) -> dict[str, object]:
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
        incompatible = _incompatible_stems(v, b, m)
        if incompatible:
            return incompatible
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
            peak = max(peak, float(np.max(np.abs(ms))))
            rows.append(_audit_block(vs, bs, ms, vocal_gain, window, band))
    return _audit_result(rows, peak, sr, vocal_gain_db)


def _incompatible_stems(
    v: sf.SoundFile, b: sf.SoundFile, m: sf.SoundFile
) -> dict[str, object] | None:
    if (
        len({v.samplerate, b.samplerate, m.samplerate}) != 1
        or len({v.frames, b.frames, m.frames}) != 1
    ):
        return {"status": "incompatible-stems", "note": "Sample rates or lengths differ"}
    if v.channels != b.channels or v.channels != m.channels:
        return {
            "status": "incompatible-channels",
            "channels": [v.channels, b.channels, m.channels],
        }
    return None


def _audit_block(
    vs: np.ndarray,
    bs: np.ndarray,
    ms: np.ndarray,
    vocal_gain: float,
    window: np.ndarray,
    band: np.ndarray,
) -> tuple[float, ...]:
    block_frames = len(window)
    x, y, z = (a.astype(np.float64) for a in (vs, bs, ms))
    x *= vocal_gain
    vp, bp = float(np.mean(x * x)), float(np.mean(y * y))
    # FFT per channel; do not cancel stereo out-of-phase energy.
    if len(x) < block_frames:
        x = np.pad(x, ((0, block_frames - len(x)), (0, 0)))
        y = np.pad(y, ((0, block_frames - len(y)), (0, 0)))
    xf, yf = np.fft.rfft(x * window, axis=0), np.fft.rfft(y * window, axis=0)
    # Normalized difference between the pre-limiter sum and actual output.
    predicted = x[: len(vs)] + y[: len(vs)]
    difference = ms.astype(np.float64) - predicted
    residual = float(np.mean(difference * difference))
    predicted_power = float(np.mean(predicted * predicted))
    # The residual is measured on the actual encoded output, not inferred
    # from the limiter settings. This also detects unexpectedly changed
    # delivery routing and vocal gain.
    return (
        vp,
        bp,
        float(np.sum(np.abs(xf[band]) ** 2)),
        float(np.sum(np.abs(yf[band]) ** 2)),
        residual,
        predicted_power,
        float(np.mean(z * z)),
        float(np.mean(z * predicted)),
    )


def _audit_result(
    rows: list[tuple[float, ...]], peak: float, sr: int, vocal_gain_db: float
) -> dict[str, object]:
    if not rows:
        return {"status": "empty"}
    p = np.asarray(rows)
    active = p[:, 0] > max(float(np.percentile(p[:, 0], 80)) * 0.15, 1e-10)
    if not np.any(active):
        return {
            "status": "no-active-vocal",
            "outputSamplePeakDbfs": round(float(20 * np.log10(max(peak, 1e-12))), 2),
        }
    ratios = 10 * np.log10(np.maximum(p[active, 0], 1e-12) / np.maximum(p[active, 1], 1e-12))
    spectral = 10 * np.log10(np.maximum(p[active, 2], 1e-12) / np.maximum(p[active, 3], 1e-12))
    # Least-squares gain of the delivered master against the pre-limiter mix.
    # A negative value can reveal unintended global attenuation. It is not
    # interpreted as vocal-specific attenuation, which cannot be recovered
    # uniquely from a stereo master.
    delivered_gain = np.maximum(p[active, 7], 0) / np.maximum(p[active, 5], 1e-16)
    delivered_gain_db = 20 * np.log10(np.maximum(delivered_gain, 1e-12))
    residual_db = 10 * np.log10(np.maximum(p[active, 4], 1e-16) / np.maximum(p[active, 5], 1e-16))
    return {
        "status": "measured",
        "method": "active-stereo-stem-power-and-output-residual",
        "deliveryVocalGainDb": round(vocal_gain_db, 3),
        "activeBlocks": int(np.sum(active)),
        "vocalToBackingMedianDb": round(float(np.median(ratios)), 2),
        "vocalToBackingP10Db": round(float(np.percentile(ratios, 10)), 2),
        "vocalToBackingP90Db": round(float(np.percentile(ratios, 90)), 2),
        "voiceBandHz": [300, int(min(3500, sr / 2))],
        "voiceBandVocalToBackingMedianDb": round(float(np.median(spectral)), 2),
        "voiceBandVocalToBackingP10Db": round(float(np.percentile(spectral, 10)), 2),
        "voiceBandVocalToBackingP90Db": round(float(np.percentile(spectral, 90)), 2),
        "voiceBandBackingDominantFraction": round(float(np.mean(spectral < 0)), 3),
        "deliveredMixGainMedianDb": round(float(np.median(delivered_gain_db)), 2),
        "deliveredMixGainP10Db": round(float(np.percentile(delivered_gain_db, 10)), 2),
        "outputVsStemSumResidualMedianDb": round(float(np.median(residual_db)), 2),
        "outputSamplePeakDbfs": round(float(20 * np.log10(max(peak, 1e-12))), 2),
        "note": "Residual includes limiter, quantization, and any other delivery processing; not a vocal-only masking metric",
    }


def reference_voice_band_balance(
    vocal: Path, backing: Path, *, block_frames: int = 16384
) -> float | None:
    result = reference_voice_band_distribution(vocal, backing, block_frames=block_frames)
    return result["median"] if result else None


def _seek_reference(
    v: sf.SoundFile, b: sf.SoundFile, time_range: tuple[float, float] | None
) -> int | None:
    if time_range is not None:
        start, end = time_range
        if not (np.isfinite(start) and np.isfinite(end) and 0 <= start < end):
            return None
        start_frame = min(v.frames, int(start * v.samplerate))
        end_frame = min(v.frames, int(end * v.samplerate))
        if end_frame <= start_frame:
            return None
        v.seek(start_frame)
        b.seek(start_frame)
    else:
        end_frame = v.frames
    return int(end_frame)


def _reference_rows(
    v: sf.SoundFile, b: sf.SoundFile, end_frame: int, block_frames: int
) -> list[tuple[float, float]]:
    freqs = np.fft.rfftfreq(block_frames, 1 / v.samplerate)
    band = (freqs >= 300) & (freqs <= min(3500, v.samplerate / 2))
    window = np.hanning(block_frames)[:, None]
    rows = []
    while v.tell() < end_frame:
        frames = min(block_frames, end_frame - v.tell())
        x = v.read(frames, dtype="float32", always_2d=True)
        y = b.read(frames, dtype="float32", always_2d=True)
        if not len(x):
            break
        if len(x) != len(y):
            return []
        activity = float(np.mean(x.astype(np.float64) ** 2))
        if len(x) < block_frames:
            x = np.pad(x, ((0, block_frames - len(x)), (0, 0)))
            y = np.pad(y, ((0, block_frames - len(y)), (0, 0)))
        vp = float(np.sum(np.abs(np.fft.rfft(x * window, axis=0)[band]) ** 2) / v.channels)
        bp = float(np.sum(np.abs(np.fft.rfft(y * window, axis=0)[band]) ** 2) / b.channels)
        rows.append((activity, 10 * np.log10(max(vp, 1e-12) / max(bp, 1e-12))))
    return rows


def reference_voice_band_distribution(
    vocal: Path,
    backing: Path,
    *,
    block_frames: int = 16384,
    time_range: tuple[float, float] | None = None,
) -> dict[str, float] | None:
    """Reference distribution of vocal prominence, including quiet and loud phrases.

    Uses stereo channel powers and only active-vocal windows. No target dB
    is hard-coded: the song itself supplies the distribution.
    """
    with sf.SoundFile(vocal) as v, sf.SoundFile(backing) as b:
        if v.samplerate != b.samplerate or v.frames != b.frames or not v.frames:
            return None
        end_frame = _seek_reference(v, b, time_range)
        if end_frame is None:
            return None
        rows = _reference_rows(v, b, end_frame, block_frames)
    if len(rows) < 3:
        return None
    values = np.asarray(rows)
    active = values[:, 0] > max(float(np.percentile(values[:, 0], 80)) * 0.15, 1e-10)
    if np.count_nonzero(active) < 3:
        return None
    distribution = values[active, 1]
    return {
        name: float(np.percentile(distribution, q))
        for name, q in (("p10", 10), ("median", 50), ("p90", 90))
    }
