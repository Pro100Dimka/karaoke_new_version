from __future__ import annotations
from dataclasses import asdict, replace
from contextlib import ExitStack
from pathlib import Path
import math
import shutil
import threading
import numpy as np
import soundfile as sf
from scipy.signal import lfilter, oaconvolve
from scipy.ndimage import median_filter
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import (
    MasterRenderer,
    _check_cancel,
    _profile,
    _PROFILE_SECONDS,
    _temporary_wave,
)
from backend.recordings.studio_compression import _reference_compressor_timing
from backend.recordings.studio_space_analysis import (
    _cepstrum as _cepstrum,
    _delay as _delay,
    SpaceProfile as SpaceProfile,
    analyze_space as analyze_space,
    match_space as match_space,
    write_impulse as write_impulse,
    _read_evidence,
)


def _estimate_ambience(
    reference: Path,
    expected: SpaceProfile,
    existing: SpaceProfile,
    cancel: threading.Event,
) -> dict[str, SpaceProfile]:
    width = max(0.0, expected.stereo_width - existing.stereo_width)
    if expected.reverb_gain or width < 0.05:
        return {}
    levels, _, _ = _read_evidence(reference, cancel, include_cepstra=False)
    if len(levels) < 150:
        return {}
    smooth = median_filter(levels, size=5)
    active = smooth > max(-60.0, float(np.percentile(smooth, 80)) - 18.0)
    edges = np.diff(np.r_[False, ~active, False].astype(int))
    gaps = (np.flatnonzero(edges == -1) - np.flatnonzero(edges == 1)) * 0.02
    gaps = gaps[(gaps >= 0.08) & (gaps <= 2.0)]
    if len(gaps) < 3:
        return {}
    room_seconds = float(np.clip(np.median(gaps) * 2.5, 0.2, 0.6))
    room = SpaceProfile(
        decay_seconds=room_seconds,
        reverb_gain=min(0.2, math.sqrt(width) * 0.375),
        stereo_width=expected.stereo_width,
        tail_band_hz=(600.0, 3500.0),
    )
    result = {"estimated-room": room}
    timing = _reference_compressor_timing(levels[::5])
    if timing["timingMethod"] == "reference-phrase-envelope":
        result["estimated-tail"] = replace(
            room,
            decay_seconds=float(np.clip(float(timing["releaseMs"]) / 500, 0.35, 1.8)),
            reverb_gain=min(0.15, math.sqrt(width) * 0.28125),
            tail_band_hz=(600.0, 4500.0),
        )
    return result


def apply_reference_space(
    renderer: MasterRenderer,
    reference: Path,
    recorded: Path,
    voice: Path,
    target: Path,
    cancel: threading.Event,
    *,
    full_reference: Path | None = None,
) -> dict[str, object]:
    expected, existing = analyze_space(reference, cancel), analyze_space(recorded, cancel)
    selected = match_space(expected, existing)
    ambience = _estimate_ambience(full_reference or reference, expected, existing, cancel)
    wet, field = _render_chain(renderer, voice, target, cancel, selected, ambience)
    if wet.get("buses"):
        width = _match_stereo_width(voice, target, _reference_side_ratio(reference, cancel), cancel)
        wet["stereoBalance"] = width
        if width.get("applied"):
            wet["dryPreserved"] = False
            calibration = wet.get("calibration")
            if isinstance(calibration, dict):
                calibration["scope"] = "before-stereo-balance"
    calibration = wet.get("calibration", {})
    applied = (
        isinstance(calibration, dict) and calibration.get("measuredOutputWetToDryDb") is not None
    ) or field.get("applied", False)
    return {
        "method": "reference-cepstrum-pause-decay-and-stereo",
        "status": "matched" if applied else "no-supported-addition",
        "estimatedNotDetected": bool(
            ambience or (selected.reverb_gain and not expected.reverb_gain)
        ),
        "estimatedAmbience": {name: asdict(spec) for name, spec in ambience.items()},
        "reference": asdict(expected),
        "recorded": asdict(existing),
        "applied": asdict(selected),
        "wetBalance": wet,
        "stereoField": field,
        "effectDetection": _effect_detection(expected),
    }


def _effect_detection(expected: SpaceProfile) -> dict[str, object]:
    return {
        "delayConfidence": expected.delay_support,
        "reverbEvidenceCount": expected.decay_count,
        "predelay": "unidentified-no-added-delay",
        "earlyReflections": "not-separated-from-direct-vocal",
        "doubling": "not-identifiable-from-stereo-width-alone",
        "tailColorMethod": "measured-decay-window-spectral-quantiles"
        if expected.reverb_gain
        else "estimated-delayed-stereo-energy-band",
        "stereoCorrelationApproximation": 1 - expected.stereo_width,
    }


def _render_chain(
    renderer: MasterRenderer,
    voice: Path,
    target: Path,
    cancel: threading.Event,
    profile: SpaceProfile,
    ambience: dict[str, SpaceProfile] | None = None,
) -> tuple[dict[str, object], dict[str, object]]:
    # Stereo-envelope lag does not identify a doubled or pitch-modulated voice.
    # Preserve the performance instead of inventing modulated vocal copies.
    wet = _render_separate_buses(renderer, voice, target, cancel, profile, ambience=ambience)
    return wet, {"applied": False, "method": "no-identified-doubling-effect"}


def apply_fallback_space(
    renderer: MasterRenderer, voice: Path, backing: Path, target: Path, cancel: threading.Event
) -> dict[str, object]:
    _check_cancel(cancel)
    shutil.copyfile(voice, target)
    return {"applied": False, "method": "no-supported-spatial-evidence"}


def _reference_side_ratio(path: Path, cancel: threading.Event) -> float:
    levels = _profile(path, cancel)
    active = levels > max(-100.0, float(np.percentile(levels, 80)) - 10.0)
    mid_energy = side_energy = 0.0
    with sf.SoundFile(path) as source:
        if source.channels != 2:
            return 0.0
        size = round(source.samplerate * _PROFILE_SECONDS)
        for index, block in enumerate(source.blocks(blocksize=size, always_2d=True)):
            _check_cancel(cancel)
            if not active[index]:
                continue
            mid_energy += float(np.sum(block.mean(axis=1) ** 2))
            side_energy += float(np.sum(((block[:, 0] - block[:, 1]) / 2) ** 2))
    return side_energy / max(mid_energy, 1e-20)


def _match_stereo_width(
    voice: Path, target: Path, reference_ratio: float, cancel: threading.Event
) -> dict[str, object]:
    if sf.info(voice).channels != 2 or reference_ratio <= 0:
        return {"applied": False, "method": "no-stereo-reference"}
    mid_energy = dry_side_energy = wet_side_energy = cross = energy = 0.0
    with sf.SoundFile(voice) as dry, sf.SoundFile(target) as mixed:
        for block in dry.blocks(blocksize=65536, always_2d=True):
            _check_cancel(cancel)
            output = mixed.read(len(block), always_2d=True)
            dry_side = (block[:, 0] - block[:, 1]) / 2
            wet_side = (output[:, 0] - output[:, 1]) / 2 - dry_side
            mid_energy += float(np.sum(output.mean(axis=1) ** 2))
            dry_side_energy += float(np.sum(dry_side**2))
            wet_side_energy += float(np.sum(wet_side**2))
            cross += float(np.sum(dry_side * wet_side))
            energy += float(np.sum(output**2))
    current_side = dry_side_energy + 2 * cross + wet_side_energy
    desired_side = min(reference_ratio * 0.5, 0.2) * mid_energy
    if desired_side <= current_side or wet_side_energy <= energy * 1e-10:
        return {"applied": False, "method": "existing-width-preserved"}
    factor = (
        -cross + math.sqrt(max(0.0, cross**2 + wet_side_energy * (desired_side - dry_side_energy)))
    ) / wet_side_energy
    gain = math.sqrt(energy / (energy + 2 * (desired_side - current_side)))
    _write_stereo_width(voice, target, factor, gain, cancel)
    return {
        "applied": True,
        "method": "reference-diffuse-side-energy",
        "referenceSideToMidRatio": reference_ratio,
        "beforeSideToMidRatio": current_side / max(mid_energy, 1e-20),
        "afterSideToMidRatio": desired_side / max(mid_energy, 1e-20),
        "wetSideGainDb": 20 * math.log10(factor),
        "normalizationGainDb": 20 * math.log10(gain),
        "centerPreservedUpToLevel": True,
    }


def _write_stereo_width(
    voice: Path, target: Path, factor: float, gain: float, cancel: threading.Event
) -> None:
    temporary = target.with_suffix(".width.wav")
    try:
        with (
            sf.SoundFile(voice) as dry,
            sf.SoundFile(target) as mixed,
            _temporary_wave(temporary, samplerate=dry.samplerate, channels=2) as writer,
        ):
            for block in dry.blocks(blocksize=65536, always_2d=True):
                _check_cancel(cancel)
                output = mixed.read(len(block), always_2d=True)
                wet_side = ((output[:, 0] - output[:, 1]) - (block[:, 0] - block[:, 1])) / 2
                adjustment = wet_side * (factor - 1)
                output[:, 0] += adjustment
                output[:, 1] -= adjustment
                writer.write(output * gain)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def _voice_activity_level(path: Path, cancel: threading.Event) -> float:
    """Estimate the vocal envelope scale from this recording, not a fixed dBFS.

    A coarse streaming histogram avoids loading the song into RAM.  The
    85th percentile of non-silent 20-ms RMS windows is robust to pauses.
    """
    histogram = np.zeros(128, dtype=np.int64)
    with sf.SoundFile(path) as source:
        window = max(1, int(source.samplerate * 0.02))
        pending = np.empty((0, source.channels), dtype=np.float32)
        while True:
            _check_cancel(cancel)
            chunk = source.read(32768, dtype="float32", always_2d=True)
            if not len(chunk):
                break
            samples = np.concatenate((pending, chunk))
            count = len(samples) // window
            if count:
                frames = samples[: count * window].reshape(count, window, source.channels)
                rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=(1, 2)))
                valid = rms[rms > 1e-7]
                if len(valid):
                    indices = np.clip(
                        ((20 * np.log10(valid) + 120) * (127 / 120)).astype(int), 0, 127
                    )
                    histogram += np.bincount(indices, minlength=128)
            pending = samples[count * window :]
    total = int(histogram.sum())
    if not total:
        return 0.0
    index = int(np.searchsorted(np.cumsum(histogram), 0.85 * total))
    return float(10 ** (((index * 120 / 127) - 120) / 20))


def _activity_mask(
    block: np.ndarray, rate: int, level: float, state: float
) -> tuple[np.ndarray, float]:
    """Block-independent vocal activity mask used for calibration and QC.

    An instantaneous sample threshold incorrectly treats zero crossings in a
    sung vowel as silence. The smoothed envelope matches the render ducking.
    """
    if not len(block):
        return np.zeros(0, dtype=bool), state
    smoothing = math.exp(-1.0 / (0.12 * rate))
    amplitude = np.sqrt(np.mean(block.astype(np.float64) ** 2, axis=1))
    envelope, _ = lfilter(
        [1.0 - smoothing],
        [1.0, -smoothing],
        amplitude,
        zi=[smoothing * state],
    )
    return envelope > 0.15 * level, float(envelope[-1])


def _render_separate_buses(
    renderer: MasterRenderer,
    voice: Path,
    target: Path,
    cancel: threading.Event,
    profile: SpaceProfile,
    *,
    reference: Path | None = None,
    recorded: Path | None = None,
    ambience: dict[str, SpaceProfile] | None = None,
) -> dict[str, object]:
    # Echo gains are direct tap ratios. Diffuse reverb energy is calibrated
    # against the actual voice, never against stereo width (which includes doubles).
    taps = profile.echo_taps or ((profile.delay_seconds, profile.delay_gain),)
    specs = {
        f"echo-{index + 1}": replace(
            profile,
            reverb_gain=0,
            decay_seconds=0,
            delay_seconds=delay,
            delay_gain=gain,
            echo_taps=((delay, gain),),
        )
        for index, (delay, gain) in enumerate(taps)
    }
    specs["reverb"] = replace(profile, delay_gain=0, delay_seconds=0, echo_taps=(), echo_regions=())
    specs.update(ambience or {})
    specs = {name: spec for name, spec in specs.items() if spec.delay_gain or spec.reverb_gain}
    if not specs:
        shutil.copyfile(voice, target)
        return {"buses": {}, "status": "no-effects", "dryPreserved": True}
    return _SpatialBuses(voice, target, cancel, specs).run()


class _SpatialBuses:
    def __init__(
        self, voice: Path, target: Path, cancel: threading.Event, specs: dict[str, SpaceProfile]
    ) -> None:
        self.voice, self.target, self.cancel, self.specs = voice, target, cancel, specs
        self.info = sf.info(voice)
        self.paths = {name: target.with_name(f"{target.stem}.{name}.wet.wav") for name in specs}
        self.impulses = {name: target.with_name(f"{target.stem}.{name}.ir.wav") for name in specs}
        self.peaks: dict[str, float] = {}
        self.gains: dict[str, float] = {}
        self.activity = _voice_activity_level(voice, cancel)

    def run(self) -> dict[str, object]:
        try:
            for name, spec in self.specs.items():
                self._convolve(name, spec)
            return self._mix()
        finally:
            for path in (*self.paths.values(), *self.impulses.values()):
                path.unlink(missing_ok=True)

    def _convolve(self, name: str, profile: SpaceProfile) -> None:
        write_impulse(profile, self.impulses[name], self.info.samplerate, self.info.channels)
        impulse, _ = sf.read(self.impulses[name], dtype="float32", always_2d=True)
        overlap = np.zeros((len(impulse) - 1, self.info.channels), dtype="float32")
        wet_peak = dry_peak = 0.0
        wet_energy = dry_energy = 0.0
        position = 0
        with (
            sf.SoundFile(self.voice) as source,
            _temporary_wave(
                self.paths[name],
                samplerate=self.info.samplerate,
                channels=self.info.channels,
            ) as output,
        ):
            for block in source.blocks(blocksize=32768, dtype="float32", always_2d=True):
                _check_cancel(self.cancel)
                wet = oaconvolve(block, impulse, mode="full", axes=0).astype("float32")
                wet[: len(overlap)] += overlap
                overlap = wet[len(block) :].copy()
                wet = wet[: len(block)]
                wet *= self._region_mask(profile, position, len(block))[:, None]
                position += len(block)
                dry_peak = max(dry_peak, float(np.max(np.abs(block))))
                wet_peak = max(wet_peak, float(np.max(np.abs(wet))))
                dry_energy += float(np.sum(block.astype(np.float64) ** 2))
                wet_energy += float(np.sum(wet.astype(np.float64) ** 2))
                output.write(wet)
        self.peaks[name] = wet_peak
        # Unit-energy noise impulses do not preserve Wet/Dry for colored vocals.
        gain = (
            profile.reverb_gain * math.sqrt(dry_energy / max(wet_energy, 1e-20))
            if profile.reverb_gain
            else 1.0
        )
        self.gains[name] = min(gain, 0.5 * dry_peak / max(wet_peak, 1e-12))

    def _region_mask(self, profile: SpaceProfile, position: int, frames: int) -> np.ndarray:
        regions = [
            (start, end)
            for delay, start, end in profile.echo_regions
            if abs(delay - profile.delay_seconds) < 0.001
        ]
        if not regions:
            return np.ones(frames)
        if abs(profile.duration - self.info.duration) > 0.02:
            return np.zeros(frames)
        time = (position + np.arange(frames)) / self.info.samplerate
        mask = np.zeros(frames)
        for start, end in regions:
            # Fade at the evidence-window boundary to avoid a discontinuous tap.
            envelope = np.minimum(
                np.clip((time - start) / 0.05, 0, 1),
                np.clip((end + profile.delay_seconds - time) / 0.05, 0, 1),
            )
            mask = np.maximum(mask, envelope)
        return mask

    def _mix(self) -> dict[str, object]:
        energy = {name: 0.0 for name in self.paths}
        dry_energy = wet_energy = peak = active_dry = active_wet = state = 0.0
        with ExitStack() as stack:
            dry = stack.enter_context(sf.SoundFile(self.voice))
            readers = {
                name: stack.enter_context(sf.SoundFile(path)) for name, path in self.paths.items()
            }
            output = stack.enter_context(
                _temporary_wave(
                    self.target,
                    samplerate=self.info.samplerate,
                    channels=self.info.channels,
                )
            )
            for block in dry.blocks(blocksize=32768, dtype="float32", always_2d=True):
                _check_cancel(self.cancel)
                wet = np.zeros_like(block)
                for name, reader in readers.items():
                    bus = (
                        reader.read(len(block), dtype="float32", always_2d=True) * self.gains[name]
                    )
                    energy[name] += float(np.sum(bus.astype(np.float64) ** 2))
                    wet += bus
                if not np.isfinite(wet).all():
                    raise DependencyError("StudioMasterInvalidWet", "Invalid spatial samples")
                active, state = _activity_mask(block, self.info.samplerate, self.activity, state)
                dry_energy += float(np.sum(block.astype(np.float64) ** 2))
                wet_energy += float(np.sum(wet.astype(np.float64) ** 2))
                active_dry += float(np.sum(block[active].astype(np.float64) ** 2))
                active_wet += float(np.sum(wet[active].astype(np.float64) ** 2))
                peak = max(peak, float(np.max(np.abs(block + wet))))
                output.write(block + wet)
        return self._report(energy, dry_energy, wet_energy, active_dry, active_wet, peak)

    def _report(
        self,
        energy: dict[str, float],
        dry: float,
        wet: float,
        active_dry: float,
        active_wet: float,
        peak: float,
    ) -> dict[str, object]:
        def ratio(a: float, b: float) -> float | None:
            return 10 * math.log10(a / b) if min(a, b) > 1e-20 else None

        return {
            "status": "rendered",
            "dryPreserved": True,
            "referenceMethod": (
                "estimated-reference-phrase-and-stereo"
                if any(name.startswith("estimated-") for name in self.specs)
                else "measured-temporal-evidence"
            ),
            "buses": {
                name: {
                    "gainDb": 20 * math.log10(max(gain, 1e-12)),
                    "wetToDryDb": ratio(energy[name], dry),
                }
                for name, gain in self.gains.items()
            },
            "calibration": {
                "measuredOutputWetToDryDb": ratio(wet, dry),
                "activeWetToDryDb": ratio(active_wet, active_dry),
                "measuredOutputPeak": peak,
                "audibilityVerified": False,
                "estimatedSpatialEffect": True,
            },
        }
