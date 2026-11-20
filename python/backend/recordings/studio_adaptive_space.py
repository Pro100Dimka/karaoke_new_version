"""Conservative separate wet buses; no chorus, pitch clones or periodic reverb kernels."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
import math
import shutil
import threading

import numpy as np
import soundfile as sf
from scipy.fft import irfft, next_fast_len, rfft
from scipy.ndimage import gaussian_filter1d, median_filter
from scipy.signal import butter, sosfilt, lfilter

from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_regional_space import render_regional_sends
from backend.recordings.studio_regional_evidence import (
    estimate_tempo as estimate_tempo,
    _diffuse_spectrum as _diffuse_spectrum,
)
from backend.recordings.studio_audio import _band_power, _check_cancel, _profile, _temporary_wave
from backend.recordings.studio_space_analysis import _delay, _fit_decay, _read_evidence
from backend.recordings.studio_space import _voice_activity_level, _activity_mask
from backend.recordings.studio_field import (
    plan_diffuse_field,
    render_diffuse_send,
)


def _tail_candidates(levels: np.ndarray) -> list[tuple[int, float, float]]:
    smooth = median_filter(levels, size=3)
    floor = max(-85.0, float(np.percentile(smooth, 10)) + 6)
    indices = np.union1d(
        np.flatnonzero(smooth[:-2] - smooth[2:] > 5) + 2,
        np.flatnonzero(smooth[:-4] - smooth[4:] > 6) + 4,
    )
    fits = []
    for index in indices:
        if index < 12:
            continue
        fit = _fit_decay(smooth, int(index), floor)
        if fit is not None:
            fits.append((int(index), *fit))
    return fits


def _tail_band_agreement(frames: np.ndarray, rate: int, decay: float) -> bool:
    agreeing = 0
    for low, high in ((250, 1000), (1000, 3000), (3000, 7000)):
        upper = min(high, rate * 0.45)
        if upper <= low:
            continue
        levels = 10 * np.log10(np.maximum(_band_power(frames, rate, (low, upper)), 1e-12))
        smooth = median_filter(levels, size=3)
        floor = max(-85.0, float(np.min(smooth[12:])) + 6)
        fit = _fit_decay(smooth, 12, floor)
        if fit is not None and abs(math.log(fit[0] / decay)) < 0.4:
            agreeing += 1
    return agreeing >= 2


def _corroborated_tail(source: sf.SoundFile, index: int, decay: float) -> bool:
    step = max(1, round(source.samplerate * 0.02))
    source.seek((index - 12) * step)
    samples = source.read(72 * step, always_2d=True)
    frames = samples[: len(samples) // step * step].reshape(-1, step, source.channels)
    if len(frames) < 19 or not _diffuse_spectrum(samples[12 * step :], source.samplerate):
        return False
    return _tail_band_agreement(frames, source.samplerate, decay)


def _tail_evidence(path: Path, cancel: threading.Event) -> tuple[float, float, int]:
    candidates = _tail_candidates(_profile(path, cancel, frame_seconds=0.02))
    evidence = []
    previous = -50
    with sf.SoundFile(path) as source:
        for index, decay, gain in candidates:
            _check_cancel(cancel)
            if index - previous < 50 or not _corroborated_tail(source, index, decay):
                continue
            evidence.append((decay, gain))
            previous = index
    if not evidence:
        return 0.0, 0.0, 0
    decays, gains = np.asarray(evidence).T
    consistent = abs(np.log(decays / np.median(decays))) < 0.4
    if not consistent.any():
        return 0.0, 0.0, 0
    return (
        float(np.clip(np.median(decays[consistent]), 0.2, 2.0)),
        float(np.clip(np.median(gains[consistent]), 0, 0.18)),
        int(np.count_nonzero(consistent)),
    )


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
    delay_seconds: float
    delay_amount: float
    report: dict[str, object]


def _echo_window_support(path: Path, positions: np.ndarray, cancel: threading.Event) -> float:
    if len(positions) > 24:
        positions = positions[np.linspace(0, len(positions) - 1, 24).astype(int)]
    supported = []
    with sf.SoundFile(path) as source:
        width = max(64, round(source.samplerate * 0.24))
        for position in positions:
            _check_cancel(cancel)
            source.seek(round(float(position) * source.samplerate))
            audio = source.read(width * 8, always_2d=True)
            complete = len(audio) // width * width
            if complete < width:
                continue
            frames = audio[:complete].reshape(-1, width, source.channels)
            strongest = frames[np.argmax(np.mean(frames**2, axis=(1, 2)))]
            supported.append(_diffuse_spectrum(strongest, source.samplerate))
    return float(np.mean(supported)) if np.count_nonzero(supported) >= 3 else 0.0


def _echo_evidence(path: Path | None, cancel: threading.Event) -> tuple[float, float, float]:
    if path is None:
        return 0.0, 0.0, 0.0
    _, cepstra, positions = _read_evidence(path, cancel)
    delay, gain, support = _delay(cepstra)
    if not gain:
        return 0.0, 0.0, 0.0
    # A long-quefrency peak can also be produced by dry vibrato or a pitch glide.
    # Require independent, spectrally broad active windows before adding a copy.
    agreeing = cepstra[:, round(delay * 8000)] > 0.01
    corroboration = _echo_window_support(path, positions[agreeing], cancel)
    return (delay, gain, min(support, corroboration)) if corroboration >= 0.25 else (0.0, 0.0, 0.0)


def _delay_plan(
    voice: Path, reference: Path | None, cancel: threading.Event
) -> tuple[float, float, dict[str, object]]:
    delay, expected, support = _echo_evidence(reference, cancel)
    actual_delay, actual, _ = _echo_evidence(voice, cancel) if expected else (0.0, 0.0, 0.0)
    same = abs(actual_delay - delay) <= max(0.012, delay * 0.08)
    amount = float(np.clip(expected - (actual if same else 0), 0, 0.16))
    return (
        delay,
        amount,
        {
            "referenceDelaySeconds": delay,
            "referenceDelayGain": expected,
            "referenceDelaySupport": support,
            "delayEvidenceMethod": "persistent-repeat-with-aperiodic-active-window-support",
            "existingDelaySeconds": actual_delay,
            "existingDelayGain": actual,
            "delaySendGain": amount,
            "delayDecision": "measured-reference-repeat"
            if amount >= 0.015
            else "unresolved-reference-repeat"
            if expected == 0
            else "already-present",
        },
    )


def _tempo_delay(delay: float, bpm: float | None) -> tuple[float, bool]:
    if not delay or bpm is None:
        return delay, False
    notes = 60 / bpm * np.array([0.25, 0.5, 0.75, 1, 1.5, 2])
    nearest = float(notes[np.argmin(abs(notes - delay))])
    synced = abs(nearest - delay) <= delay * 0.05
    return (nearest if synced else delay), synced


def _backing_tempo(
    backing: Path, amount: float, cancel: threading.Event, ready: Callable[[], None] | None
) -> tuple[float | None, float]:
    if amount >= 0.015:
        if ready is not None:
            ready()
        return estimate_tempo(backing, cancel)
    return None, 0.0


def _reverb_decision(expected: float, amount: float) -> str:
    if amount >= 0.015:
        return "supported-diffuse-tail"
    return "unresolved-reference-space" if expected == 0 else "already-present"


def _plan_sends(
    voice: Path,
    backing: Path,
    reference: Path | None,
    recorded_is_dry: bool,
    cancel: threading.Event,
    *,
    backing_ready: Callable[[], None] | None = None,
) -> SendPlan:
    decay, expected, support = _tail_evidence(reference, cancel) if reference else (0.0, 0.0, 0)
    # Digital dry capture still includes acoustic room decay and breathy releases.
    existing_decay, existing, existing_count = _tail_evidence(voice, cancel)
    amount = math.sqrt(max(0.0, expected**2 - existing**2))
    delay, delay_amount, delay_report = _delay_plan(voice, reference, cancel)
    bpm, confidence = _backing_tempo(backing, delay_amount, cancel, backing_ready)
    delay, synced = _tempo_delay(delay, bpm)
    report: dict[str, object] = {
        "method": "separate-diffuse-reverb-and-phrase-delay-sends",
        "dryPreserved": True,
        "referenceTailCount": support,
        "decaySeconds": decay,
        "referenceWetRatio": expected,
        "existingWetRatio": existing,
        "existingDecaySeconds": existing_decay,
        "existingTailCount": existing_count,
        "qualifiedExistingWetRatio": existing if existing_count >= 3 else 0.0,
        "reverbDecision": _reverb_decision(expected, amount),
        "reverbEvidenceMethod": "local-decay-fit-with-multiple-bands-and-aperiodic-support",
        "delayTempoSynchronized": synced,
        "recordedIsDry": recorded_is_dry,
        "wetLowCutHz": 200.0,
        "wetDuckingDb": -20 * math.log10(0.75),
        "wetDuckingSmoothingMs": 50.0,
        "diffuseField": {"applied": False},
        **delay_report,
    }
    return SendPlan(decay, amount, bpm, confidence, delay, delay_amount, report)


def _delay_bus(
    voice: Path, work: Path, plan: SendPlan, cancel: threading.Event
) -> tuple[tuple[str, Path, float], float]:
    info = sf.info(voice)
    delay_seconds = plan.delay_seconds
    impulse = np.zeros((round((delay_seconds + 0.08) * info.samplerate) + 1, info.channels))
    impulse[round(delay_seconds * info.samplerate)] = 1.0
    band = butter(
        2,
        [min(200, info.samplerate * 0.05), min(6000, info.samplerate * 0.43)],
        fs=info.samplerate,
        btype="bandpass",
        output="sos",
    )
    delayed = work / "delay.wav"
    dry_energy, _ = _convolve_send(
        voice, delayed, sosfilt(band, impulse, axis=0), cancel, _phrase_end_curve(voice, cancel)
    )
    return ("delay", delayed, plan.delay_amount), dry_energy


def _reverb_bus(
    voice: Path, work: Path, plan: SendPlan, cancel: threading.Event
) -> tuple[tuple[str, Path, float], float]:
    info, reverb = sf.info(voice), work / "reverb.wav"
    impulse = _reverb_impulse(info.samplerate, info.channels, plan.decay)
    dry_energy, wet_energy = _convolve_send(voice, reverb, impulse, cancel)
    scale = min(4.0, plan.amount * math.sqrt(dry_energy / max(wet_energy, 1e-20)))
    return ("reverb", reverb, scale), dry_energy


def _render_send_buses(
    voice: Path, work: Path, plan: SendPlan, reference: Path | None, cancel: threading.Event
) -> tuple[list[tuple[str, Path, float]], float]:
    buses = []
    dry_energy = 0.0
    if plan.amount >= 0.015:
        bus, dry_energy = _reverb_bus(voice, work, plan, cancel)
        buses.append(bus)
    if plan.delay_amount >= 0.015:
        bus, dry_energy = _delay_bus(voice, work, plan, cancel)
        buses.append(bus)
    field = (
        plan_diffuse_field(reference, sf.info(voice).samplerate, cancel)
        if reference is not None and sf.info(voice).channels == 2
        else None
    )
    if field is not None:
        path = work / "diffuse-field.wav"
        gain, dry_energy, plan.report["diffuseField"] = render_diffuse_send(
            voice,
            path,
            field,
            {name: source for name, source, _ in buses},
            {name: amount for name, _, amount in buses},
            cancel,
        )
        if gain > 0:
            buses.append(("diffuse-field", path, gain))
            plan.report["wetLowCutHz"] = min(200.0, float(field.band_hz[0]))
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
        "status": "estimated-reference-ambience"
        if set(energy) == {"diffuse-field"}
        else "measured-reference-effects",
        "tempoBpm": plan.bpm,
        "tempoConfidence": plan.tempo_confidence,
        "delaySeconds": plan.delay_seconds if plan.delay_amount >= 0.015 else 0.0,
        "buses": {
            name: {"wetToDryDb": 10 * math.log10(max(value, 1e-30) / max(dry_energy, 1e-30))}
            for name, value in energy.items()
        },
    }


def _regional_returns(
    voice: Path,
    target: Path,
    plan: SendPlan,
    reference: Path | None,
    arrangement: ArrangementMap,
    buses: list[tuple[str, Path, float]],
    cancel: threading.Event,
) -> dict[str, object]:
    ducker = (
        WetDucker(sf.info(voice).samplerate, _voice_activity_level(voice, cancel))
        if buses
        else None
    )
    return render_regional_sends(
        voice,
        target,
        cancel,
        reference=reference,
        arrangement=arrangement,
        base_report=plan.report,
        legacy=buses,
        legacy_duck=ducker.envelope if ducker is not None else None,
        existing_wet=math.hypot(cast(float, plan.report["qualifiedExistingWetRatio"]), plan.amount),
    )


def render_sends(
    voice: Path,
    backing: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference: Path | None = None,
    recorded_is_dry: bool = True,
    arrangement: ArrangementMap | None = None,
    backing_ready: Callable[[], None] | None = None,
) -> dict[str, object]:
    _check_cancel(cancel)
    plan = _plan_sends(
        voice, backing, reference, recorded_is_dry, cancel, backing_ready=backing_ready
    )
    with TemporaryDirectory(prefix=".sends-", dir=target.parent) as directory:
        field_reference = reference if arrangement is None else None
        buses, dry_energy = _render_send_buses(
            voice, Path(directory), plan, field_reference, cancel
        )
        if arrangement is not None:
            return _regional_returns(voice, target, plan, reference, arrangement, buses, cancel)
        if not buses:
            shutil.copyfile(voice, target)
            return {
                **plan.report,
                "applied": False,
                "status": "no-supported-addition",
                "buses": {},
                "tempoBpm": None,
                "tempoConfidence": 0.0,
            }
        energy = _mix_returns(voice, target, buses, cancel)
    return _send_report(plan, energy, dry_energy)
