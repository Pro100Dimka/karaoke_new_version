"""Conservative separate wet buses; no chorus, pitch clones or periodic reverb kernels."""

from __future__ import annotations

from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
import math
import shutil
import threading

import numpy as np
import soundfile as sf
from scipy.fft import irfft, next_fast_len, rfft
from scipy.ndimage import gaussian_filter1d
from scipy.signal import butter, correlate, find_peaks, sosfilt, lfilter

from backend.recordings.studio_audio import _check_cancel, _profile, _temporary_wave
from backend.recordings.studio_space_analysis import _decay
from backend.recordings.studio_space import _voice_activity_level, _activity_mask


def estimate_tempo(backing: Path, cancel: threading.Event) -> tuple[float | None, float]:
    levels = _profile(backing, cancel, frame_seconds=0.02)
    if len(levels) < 250 or np.percentile(levels, 90) - np.percentile(levels, 10) < 5:
        return None, 0.0
    envelope = 10 ** ((levels - np.max(levels)) / 20)
    novelty = np.maximum(0, np.diff(envelope, prepend=envelope[0]))
    energy = float(np.dot(novelty, novelty))
    if energy < 1e-8:
        return None, 0.0
    curve = correlate(novelty, novelty, mode="full", method="fft")[len(novelty) - 1 :] / energy
    low, high = 15, min(51, len(curve))
    peaks, _ = find_peaks(curve[low - 1 : high + 1])
    candidates = peaks + low - 1
    candidates = candidates[(candidates >= low) & (candidates < high)]
    if not len(candidates):
        return None, 0.0
    best = int(candidates[np.argmax(curve[candidates])])
    confidence = float(np.clip(curve[best], 0, 1))
    # Multiple repeated attacks must agree; sustained notes and short fills have no beat proof.
    peaks_in_audio, _ = find_peaks(novelty, height=float(np.max(novelty)) * 0.25, distance=5)
    if len(peaks_in_audio) < 6 or confidence < 0.5:
        return None, confidence
    return 60 / (best * 0.02), confidence


def _tail_evidence(path: Path, cancel: threading.Event) -> tuple[float, float, int]:
    levels = _profile(path, cancel, frame_seconds=0.02)
    decay, gain, count = _decay(levels)
    if not gain or count < 3:
        return 0.0, 0.0, count
    # A periodic sustained vowel with a falling envelope is not diffuse room evidence.
    # Inspect low-level release blocks for broadband spectral support as a second test.
    samples = []
    floor = float(np.percentile(levels, 85))
    indices = np.flatnonzero((levels > floor - 32) & (levels < floor - 10))
    if len(indices) > 32:
        indices = indices[np.linspace(0, len(indices) - 1, 32).astype(int)]
    with sf.SoundFile(path) as source:
        width = max(64, round(source.samplerate * 0.04))
        hz = np.fft.rfftfreq(width, 1 / source.samplerate)
        band = (hz >= 250) & (hz < min(9000, source.samplerate * 0.45))
        for index in indices:
            _check_cancel(cancel)
            source.seek(min(source.frames, round(index * 0.02 * source.samplerate)))
            block = source.read(width, always_2d=True)
            if len(block) != width:
                continue
            spectrum = np.mean(
                abs(np.fft.rfft(block * np.hanning(width)[:, None], axis=0)) ** 2, axis=1
            )[band]
            if len(spectrum) < 4 or np.sum(spectrum) < 1e-16:
                continue
            probability = spectrum / np.sum(spectrum)
            samples.append(
                float(
                    -np.sum(probability * np.log(np.maximum(probability, 1e-20)))
                    / math.log(len(probability))
                )
            )
    if not samples or np.median(samples) < 0.5:
        return 0.0, 0.0, count
    return float(np.clip(decay, 0.2, 2.0)), float(np.clip(gain, 0, 0.18)), count


def _phrase_end_curve(voice: Path, cancel: threading.Event) -> tuple[np.ndarray, np.ndarray]:
    levels = _profile(voice, cancel, frame_seconds=0.02)
    active = levels > max(-85.0, float(np.max(levels)) - 30)
    edges = np.diff(np.pad(active.astype(int), (1, 1)))
    starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
    values = np.zeros(len(levels))
    for start, end in zip(starts, ends):
        if end - start < 8 or end >= len(levels) - 4 or active[end : end + 4].any():
            continue
        begin = max(start, end - 15)
        values[begin:end] = np.minimum(1, np.arange(end - begin) / 3)
    values = gaussian_filter1d(values, sigma=1)
    return (np.arange(len(values)) + 0.5) * 0.02, values


def _reverb_impulse(rate: int, channels: int, decay: float) -> np.ndarray:
    predelay = round(rate * 0.018)
    length = max(predelay + 1, round((decay + 0.018) * rate))
    rng = np.random.default_rng(271828)
    noise = rng.normal(size=(length - predelay, channels))
    if channels == 2:
        noise = math.sqrt(0.7) * noise[:, :1] + math.sqrt(0.3) * noise
    band = butter(
        2, [min(200, rate * 0.05), min(9000, rate * 0.43)], fs=rate, btype="bandpass", output="sos"
    )
    noise = sosfilt(band, noise, axis=0)
    time = np.arange(len(noise)) / rate
    tail = noise * np.exp(-6.907755 * time[:, None] / decay)
    tail *= np.minimum(time / 0.008, 1)[:, None]
    tail /= np.maximum(np.linalg.norm(tail, axis=0), 1e-12)
    return np.pad(tail, ((predelay, 0), (0, 0))).astype("float32")


def _convolve_send(
    voice: Path,
    target: Path,
    impulse: np.ndarray,
    cancel: threading.Event,
    curve: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[float, float]:
    info = sf.info(voice)
    size = next_fast_len(32768 + len(impulse) - 1, real=True)
    # Double precision keeps FFT roundoff below the stored PCM resolution at dry onsets.
    response = rfft(impulse.astype(np.float64), n=size, axis=0)
    overlap = np.zeros((len(impulse) - 1, info.channels), dtype="float32")
    dry_energy = wet_energy = 0.0
    offset = 0
    with (
        sf.SoundFile(voice) as source,
        _temporary_wave(target, samplerate=info.samplerate, channels=info.channels) as output,
    ):
        for block in source.blocks(blocksize=32768, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            dry_energy += float(np.sum(block.astype(np.float64) ** 2))
            if curve is not None:
                block = (
                    block
                    * np.interp((offset + np.arange(len(block))) / info.samplerate, *curve)[:, None]
                )
            wet = irfft(rfft(block.astype(np.float64), n=size, axis=0) * response, n=size, axis=0)[
                : len(block) + len(impulse) - 1
            ].astype("float32")
            wet[: len(overlap)] += overlap
            overlap = wet[len(block) :].copy()
            wet = wet[: len(block)]
            wet_energy += float(np.sum(wet.astype(np.float64) ** 2))
            output.write(wet)
            offset += len(block)
    return dry_energy, wet_energy


@dataclass(frozen=True, slots=True)
class SendPlan:
    decay: float
    amount: float
    bpm: float | None
    tempo_confidence: float
    report: dict[str, object]


def _plan_sends(
    voice: Path,
    backing: Path,
    reference: Path | None,
    recorded_is_dry: bool,
    cancel: threading.Event,
) -> SendPlan:
    decay, expected, support = _tail_evidence(reference, cancel) if reference else (0.0, 0.0, 0)
    # Digital dry capture still includes acoustic room decay and breathy releases.
    _, existing, _ = _tail_evidence(voice, cancel)
    amount = math.sqrt(max(0.0, expected**2 - existing**2))
    bpm, confidence = estimate_tempo(backing, cancel) if amount >= 0.015 else (None, 0.0)
    report: dict[str, object] = {
        "method": "separate-diffuse-reverb-and-phrase-delay-sends",
        "dryPreserved": True,
        "referenceTailCount": support,
        "decaySeconds": decay,
        "referenceWetRatio": expected,
        "existingWetRatio": existing,
        "recordedIsDry": recorded_is_dry,
        "wetLowCutHz": 200.0,
        "wetDuckingDb": -20 * math.log10(0.75),
        "wetDuckingSmoothingMs": 50.0,
    }
    return SendPlan(decay, amount, bpm, confidence, report)


def _delay_bus(
    voice: Path, work: Path, plan: SendPlan, cancel: threading.Event
) -> tuple[str, Path, float] | None:
    if plan.bpm is None or plan.tempo_confidence < 0.5:
        return None
    info = sf.info(voice)
    delay_seconds = 30 / plan.bpm
    impulse = np.zeros((round(delay_seconds * 2 * info.samplerate) + 1, info.channels))
    impulse[round(delay_seconds * info.samplerate)], impulse[-1] = 1.0, 0.25
    band = butter(
        2,
        [min(200, info.samplerate * 0.05), min(6000, info.samplerate * 0.43)],
        fs=info.samplerate,
        btype="bandpass",
        output="sos",
    )
    delayed = work / "delay.wav"
    _convolve_send(
        voice, delayed, sosfilt(band, impulse, axis=0), cancel, _phrase_end_curve(voice, cancel)
    )
    return "delay", delayed, min(0.08, plan.amount * 0.5)


def _render_send_buses(
    voice: Path, work: Path, plan: SendPlan, cancel: threading.Event
) -> tuple[list[tuple[str, Path, float]], float]:
    info, reverb = sf.info(voice), work / "reverb.wav"
    impulse = _reverb_impulse(info.samplerate, info.channels, plan.decay)
    dry_energy, wet_energy = _convolve_send(voice, reverb, impulse, cancel)
    scale = min(4.0, plan.amount * math.sqrt(dry_energy / max(wet_energy, 1e-20)))
    buses = [("reverb", reverb, scale)]
    delay = _delay_bus(voice, work, plan, cancel)
    if delay is not None:
        buses.append(delay)
    return buses, dry_energy


@dataclass(slots=True)
class WetDucker:
    rate: int
    level: float
    activity_state: float = 0.0
    gain_state: float = 0.0

    def envelope(self, block: np.ndarray) -> np.ndarray:
        active, self.activity_state = _activity_mask(
            block, self.rate, self.level, self.activity_state
        )
        smoothing = math.exp(-1.0 / (0.05 * self.rate))
        curve, _ = lfilter(
            [1 - smoothing], [1, -smoothing], active.astype(float), zi=[smoothing * self.gain_state]
        )
        self.gain_state = float(curve[-1])
        gain: np.ndarray = 1 - 0.25 * curve[:, None]
        return gain


def _mix_returns(
    voice: Path, target: Path, buses: list[tuple[str, Path, float]], cancel: threading.Event
) -> dict[str, float]:
    info = sf.info(voice)
    ducker = WetDucker(info.samplerate, _voice_activity_level(voice, cancel))
    energy = {name: 0.0 for name, _, _ in buses}
    with ExitStack() as stack:
        source = stack.enter_context(sf.SoundFile(voice))
        readers = [
            (name, stack.enter_context(sf.SoundFile(path)), gain) for name, path, gain in buses
        ]
        output = stack.enter_context(
            _temporary_wave(target, samplerate=info.samplerate, channels=info.channels)
        )
        for block in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            wet = np.zeros_like(block)
            ducking = ducker.envelope(block)
            for name, reader, gain in readers:
                bus = reader.read(len(block), dtype="float32", always_2d=True) * gain * ducking
                wet += bus
                energy[name] += float(np.sum(bus.astype(np.float64) ** 2))
            output.write(block + wet)
    return energy


def _send_report(plan: SendPlan, energy: dict[str, float], dry_energy: float) -> dict[str, object]:
    return {
        **plan.report,
        "applied": True,
        "status": "matched",
        "tempoBpm": plan.bpm,
        "tempoConfidence": plan.tempo_confidence,
        "delaySeconds": 30 / plan.bpm if plan.bpm is not None else 0.0,
        "buses": {
            name: {"wetToDryDb": 10 * math.log10(max(value, 1e-30) / max(dry_energy, 1e-30))}
            for name, value in energy.items()
        },
    }


def render_sends(
    voice: Path,
    backing: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference: Path | None = None,
    recorded_is_dry: bool = True,
) -> dict[str, object]:
    _check_cancel(cancel)
    plan = _plan_sends(voice, backing, reference, recorded_is_dry, cancel)
    if plan.amount < 0.015:
        shutil.copyfile(voice, target)
        return {
            **plan.report,
            "applied": False,
            "status": "no-supported-addition",
            "buses": {},
            "tempoBpm": None,
            "tempoConfidence": 0.0,
        }
    with TemporaryDirectory(prefix=".sends-", dir=target.parent) as directory:
        buses, dry_energy = _render_send_buses(voice, Path(directory), plan, cancel)
        energy = _mix_returns(voice, target, buses, cancel)
    return _send_report(plan, energy, dry_energy)
