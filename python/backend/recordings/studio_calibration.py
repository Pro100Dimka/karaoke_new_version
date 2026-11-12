from pathlib import Path
import threading
import numpy as np

from backend.recordings.studio_audio import MasterRenderer, _PROFILE_SECONDS, _profile
from backend.recordings.studio_delivery import measure_mix_loudness


def _balance_evidence(
    renderer: MasterRenderer, vocal: Path, backing: Path, cancel: threading.Event
) -> dict[str, float | None] | None:
    voice, music = measure_mix_loudness(renderer, vocal, backing, cancel)
    profiles = [
        _profile(path, cancel, voice_band=band)
        for band in [False, True]
        for path in (vocal, backing)
    ]
    count = min(len(voice), len(music), *(len(p) for p in profiles))
    if count < 4:
        return None
    voice, music = voice[3:count], music[3:count]
    body_v, body_m, band_v, band_m = [
        np.convolve(10 ** (p[:count] / 10), np.ones(4) / 4, mode="valid") for p in profiles
    ]
    audible = voice > -70
    if not audible.any():
        return None
    # Relative gating rejects quiet tails; a separate spectral gate rejects
    # low-frequency spill which has energy but is not the sung lead.
    gate = 10 * np.log10(np.mean(10 ** (voice[audible] / 10))) - 10
    active = audible & (voice > gate) & (music > -70)
    active &= band_v > np.mean(band_v[audible]) * 0.1
    if not active.any():
        return None
    supported = active & (band_m > 1e-10)
    return {
        "perceivedBalanceLu": float(
            10 * np.log10(np.mean(10 ** (voice[active] / 10)) / np.mean(10 ** (music[active] / 10)))
        ),
        "spectralBalanceDb": float(np.median(10 * np.log10(band_v[supported] / band_m[supported])))
        if supported.any()
        else None,
        "bodyBalanceDb": float(
            np.median(10 * np.log10(body_v[active] / np.maximum(body_m[active], 1e-12)))
        ),
        "activeSeconds": float(np.count_nonzero(active) * _PROFILE_SECONDS),
    }


def calibrate_mix(
    renderer: MasterRenderer,
    vocal: Path,
    backing: Path,
    cancel: threading.Event,
    processing: dict[str, object],
) -> float:
    """Balance audibility and perceived level on the same active vocal windows.

    The offsets are conservative mix-design goals, not broadcast targets or a
    claim that a loudness meter can replace listening to an artistic balance.
    """
    evidence = _balance_evidence(renderer, vocal, backing, cancel)
    if evidence is None:
        processing["postMixCalibration"] = {"status": "skipped-no-accompanied-vocal"}
        return 0.0
    perceived = evidence["perceivedBalanceLu"]
    body = evidence["bodyBalanceDb"]
    assert perceived is not None and body is not None
    spectral = evidence["spectralBalanceDb"]
    desired = [-2.0 - perceived]
    ceilings = [-perceived, 4.5 - body]
    if spectral is not None:
        desired.append(-spectral)
        ceilings.append(3.0 - spectral)
    correction = float(min(np.mean(desired), *ceilings))
    processing["postMixCalibration"] = {
        "method": "perceptual-and-spectral-backing-balance",
        "status": "balanced",
        **evidence,
        "beforeVocalToBackingDb": spectral,
        "targetPerceivedVocalToBackingLu": -2.0,
        "targetSpectralVocalToBackingDb": 0.0,
        "maxSpectralVocalToBackingDb": 3.0,
        "broadbandVocalCeilingDb": 4.5,
        "correctionDb": correction,
    }
    return correction
