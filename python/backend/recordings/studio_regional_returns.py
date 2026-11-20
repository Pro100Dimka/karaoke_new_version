"""Continuous convolution returns shared by diffuse rooms and supported copies."""

from dataclasses import dataclass
from pathlib import Path
import threading

import numpy as np
import soundfile as sf
from scipy.fft import irfft, next_fast_len, rfft
from scipy.signal import butter, sosfilt

from backend.recordings.studio_audio import _check_cancel, _temporary_wave


@dataclass(frozen=True, slots=True)
class AmbienceRegion:
    start: float
    end: float
    kernel: np.ndarray
    band: tuple[int, int]
    band_index: int
    ratio: float
    existing_ratio: float
    confidence: float
    evidence: str
    response_source: tuple[float, float] | None = None
    local_fit: bool = True
    evidence_origin: str = "section"
    valid_start: float | None = None
    valid_end: float | None = None

    def payload(self) -> dict[str, object]:
        return {
            "startSeconds": self.start,
            "endSeconds": self.end,
            "bandHz": list(self.band),
            "targetSideToMidPowerRatio": self.ratio,
            "existingSideToMidPowerRatio": self.existing_ratio,
            "existingSideMeasure": "after-proven-instantaneous-pan-exclusion",
            "confidence": self.confidence,
            "evidence": self.evidence,
            "responsePowerKernel": self.kernel.tolist(),
            "responseStepSeconds": 0.02,
            "wetMidEstimate": "bounded-equal-mid-side-diffuse-energy",
            "monoWetRatioCeiling": 0.35,
            "effectIdentity": "estimated-ambience-not-an-identified-plugin",
            "responseSourceInterval": self.response_source,
            "localFit": self.local_fit,
            "evidenceOrigin": self.evidence_origin,
            "referenceValidityInterval": [self.valid_start, self.valid_end],
        }


@dataclass(frozen=True, slots=True)
class EchoRegion:
    start: float
    end: float
    delay_seconds: float
    left_gain: float
    right_gain: float
    confidence: float
    existing_left: float = 0.0
    existing_right: float = 0.0
    valid_start: float | None = None
    valid_end: float | None = None
    existing_delay_seconds: float | None = None

    def payload(self) -> dict[str, object]:
        return {
            "startSeconds": self.start,
            "endSeconds": self.end,
            "delaySeconds": self.delay_seconds,
            "leftGain": self.left_gain,
            "rightGain": self.right_gain,
            "existingLeftGain": self.existing_left,
            "existingRightGain": self.existing_right,
            "existingDelaySeconds": self.existing_delay_seconds,
            "heldOutWaveformConfidence": self.confidence,
            "evidence": "regional-coherent-stereo-copy-with-held-out-waveform-validation",
            "referenceValidityInterval": [self.valid_start, self.valid_end],
            "effectIdentity": "measured-coherent-copy-not-an-identified-plugin",
        }


def _impulse(region: AmbienceRegion, rate: int) -> np.ndarray:
    time = np.arange(round(rate * 0.64)) / rate
    power = np.interp(time, np.arange(len(region.kernel)) * 0.02, region.kernel, right=0)
    noise = np.random.default_rng(314159).normal(size=(len(time), 2)) * np.sqrt(power[:, None])
    noise[: round(rate * 0.02)] = 0
    response = sosfilt(
        butter(2, region.band, fs=rate, btype="bandpass", output="sos"), noise, axis=0
    )
    response /= np.maximum(np.linalg.norm(response, axis=0), 1e-12)
    # Independent mid and side responses retain a real wet component in mono.
    return np.column_stack((response[:, 0] + response[:, 1], response[:, 0] - response[:, 1]))


def _input_curve(times: np.ndarray, region: AmbienceRegion | EchoRegion) -> np.ndarray:
    fade = 0.25
    onset = (
        np.ones(len(times))
        if region.start == 0
        else np.clip((times - region.start) / fade + 0.5, 0, 1)
    )
    release = np.clip((region.end - times) / fade + 0.5, 0, 1)
    curve = np.minimum(onset, release)
    # Production changes crossfade, but unknown reference gaps cannot excite a
    # new return. Only previously excited convolution tails may cross those gaps.
    if region.valid_start is not None:
        curve *= np.clip((times - region.valid_start) / 0.05, 0, 1)
    if region.valid_end is not None:
        curve *= np.clip((region.valid_end - times) / 0.05, 0, 1)
    return curve


def convolve_return(
    voice: Path,
    target: Path,
    region: AmbienceRegion | EchoRegion,
    impulse: np.ndarray,
    cancel: threading.Event,
) -> None:
    info = sf.info(voice)
    size = next_fast_len(32768 + len(impulse) - 1, real=True)
    response = rfft(impulse, n=size, axis=0)
    overlap = np.zeros((len(impulse) - 1, 2))
    offset = 0
    with (
        sf.SoundFile(voice) as source,
        _temporary_wave(target, samplerate=info.samplerate, channels=2) as output,
    ):
        for block in source.blocks(blocksize=32768, always_2d=True):
            _check_cancel(cancel)
            time = (offset + np.arange(len(block))) / info.samplerate
            mono = block.mean(axis=1) * _input_curve(time, region)
            length = len(block) + len(impulse) - 1
            if np.any(mono):
                wet = irfft(rfft(mono, n=size)[:, None] * response, n=size, axis=0)[:length]
            else:
                wet = np.zeros((length, 2))
            # Silent excitation still drains the previous return across every block.
            wet[: len(overlap)] += overlap
            overlap = wet[len(block) :].copy()
            output.write(wet[: len(block)])
            offset += len(block)
