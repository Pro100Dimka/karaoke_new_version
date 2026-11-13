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
from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import (
    MasterRenderer,
    _check_cancel,
    _temporary_wave,
)
from backend.recordings.studio_spectrum import measure_stereo_response, plan_band_space
from backend.recordings.studio_field import (
    DiffuseFieldPlan,
    plan_diffuse_field,
    calibrate_diffuse_field,
)
from backend.recordings.studio_space_analysis import (
    _cepstrum as _cepstrum,
    _delay as _delay,
    SpaceProfile as SpaceProfile,
    analyze_space as analyze_space,
    match_space as match_space,
    write_impulse as write_impulse,
)


def _planned_space(expected: SpaceProfile, existing: SpaceProfile) -> SpaceProfile:
    existing_taps = dict(existing.echo_taps)
    taps = tuple(
        (delay, max(0.0, gain - existing_taps.get(delay, 0.0)))
        for delay, gain in expected.echo_taps
    )
    taps = tuple((delay, gain) for delay, gain in taps if gain > 0)
    bands = [expected.tail_band_hz, existing.tail_band_hz]
    comparable = not all(0 < low < high for low, high in bands) or (
        max(band[0] for band in bands) < min(band[1] for band in bands)
    )
    present = existing.reverb_gain if comparable else 0.0
    reverb = (
        math.sqrt(max(0.0, expected.reverb_gain**2 - present**2))
        if expected.decay_count >= 3
        else 0.0
    )
    return SpaceProfile(
        echo_taps=taps,
        echo_regions=expected.echo_regions,
        duration=expected.duration,
        decay_seconds=expected.decay_seconds if reverb else 0.0,
        reverb_gain=reverb,
        stereo_width=expected.stereo_width,
        tail_band_hz=expected.tail_band_hz,
    )


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
    expected, tail_source = _reference_tail(expected, full_reference, reference, cancel)
    selected = _planned_space(expected, existing)
    response, field = _side_plan(reference, recorded, voice, cancel)
    bands = {}
    if not expected.reverb_gain:
        bands = plan_band_space(full_reference or reference, voice, expected.stereo_width, cancel)
    wet = _render_separate_buses(
        renderer,
        voice,
        target,
        cancel,
        selected,
        side_response=response,
        ambience=bands,
        reference=full_reference or reference,
    )
    return {
        "method": "single-wet-return",
        "status": "matched" if wet.get("buses") else "no-supported-addition",
        "reference": asdict(expected),
        "recorded": asdict(existing),
        "reverbEvidenceSource": tail_source,
        "applied": asdict(selected),
        "wetBalance": wet,
        "dryPreserved": True,
        "stereoField": field,
        "bandTails": {name: asdict(profile) for name, profile in bands.items()},
        "diffuseField": wet.get("diffuseField", {"applied": False}),
    }


def _reference_tail(
    expected: SpaceProfile, full: Path | None, scoped: Path, cancel: threading.Event
) -> tuple[SpaceProfile, str]:
    if expected.reverb_gain or full is None or full == scoped:
        return expected, "performed-section"
    complete = analyze_space(full, cancel)
    if not complete.reverb_gain or complete.decay_count < 3:
        return expected, "performed-section"
    return replace(
        expected,
        decay_seconds=complete.decay_seconds,
        reverb_gain=complete.reverb_gain,
        decay_count=complete.decay_count,
        tail_band_hz=complete.tail_band_hz,
    ), "full-song"


def _side_plan(
    reference: Path, recorded: Path, voice: Path, cancel: threading.Event
) -> tuple[np.ndarray, dict[str, object]]:
    info = sf.info(voice)
    response, score = (
        measure_stereo_response(reference, info.samplerate, cancel)
        if info.channels == 2 and reference != recorded
        else (np.empty(0), 0.0)
    )
    if response.size:
        existing, _ = measure_stereo_response(recorded, info.samplerate, cancel)
        if existing.size:
            present = float(np.dot(response, existing) / max(np.dot(response, response), 1e-20))
            response *= 1 - np.clip(present, 0, 1)
    applied = bool(response.size and np.linalg.norm(response) > 1e-6)
    return response if applied else np.empty(0), {
        "applied": applied,
        "method": "cross-validated-causal-stereo-response",
        "heldOutImprovement": score,
        "directVoicePreserved": True,
    }


def apply_fallback_space(
    renderer: MasterRenderer, voice: Path, backing: Path, target: Path, cancel: threading.Event
) -> dict[str, object]:
    _check_cancel(cancel)
    shutil.copyfile(voice, target)
    return {"applied": False, "method": "no-supported-spatial-evidence"}


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
    side_response: np.ndarray | None = None,
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
    if side_response is not None and side_response.size:
        specs["stereo-reflections"] = SpaceProfile()
    diffuse_field = None
    if reference is not None and sf.info(voice).channels == 2:
        diffuse_field = plan_diffuse_field(reference, sf.info(voice).samplerate, cancel)
    if diffuse_field is not None:
        specs["diffuse-field"] = SpaceProfile()
    if not specs:
        shutil.copyfile(voice, target)
        return {"buses": {}, "status": "no-effects", "dryPreserved": True}
    return _SpatialBuses(voice, target, cancel, specs, side_response, diffuse_field).run()


class _SpatialBuses:
    def __init__(
        self,
        voice: Path,
        target: Path,
        cancel: threading.Event,
        specs: dict[str, SpaceProfile],
        side_response: np.ndarray | None = None,
        diffuse_field: DiffuseFieldPlan | None = None,
    ) -> None:
        self.voice, self.target, self.cancel, self.specs = voice, target, cancel, specs
        self.info = sf.info(voice)
        self.paths = {name: target.with_name(f"{target.stem}.{name}.wet.wav") for name in specs}
        self.impulses = {name: target.with_name(f"{target.stem}.{name}.ir.wav") for name in specs}
        self.gains: dict[str, float] = {}
        self.limits: dict[str, float] = {}
        self.activity = _voice_activity_level(voice, cancel)
        self.responses = {
            "stereo-reflections": side_response if side_response is not None else np.empty(0)
        }
        self.diffuse_field = diffuse_field
        self.field_calibration: dict[str, object] = {"applied": False}
        if diffuse_field is not None:
            self.responses["diffuse-field"] = diffuse_field.response

    def run(self) -> dict[str, object]:
        try:
            for name, spec in self.specs.items():
                self._convolve(name, spec)
            if self.diffuse_field is not None:
                self.gains["diffuse-field"], self.field_calibration = calibrate_diffuse_field(
                    self.voice,
                    self.paths,
                    self.gains,
                    self.diffuse_field,
                    self.limits["diffuse-field"],
                    self.cancel,
                )
            return self._mix()
        finally:
            for path in (*self.paths.values(), *self.impulses.values()):
                path.unlink(missing_ok=True)

    def _impulse(self, name: str, profile: SpaceProfile) -> np.ndarray:
        if name in self.responses:
            response = self.responses[name]
            return np.column_stack((response, -response)).astype("float32")
        write_impulse(profile, self.impulses[name], self.info.samplerate, self.info.channels)
        return np.asarray(sf.read(self.impulses[name], dtype="float32", always_2d=True)[0])

    def _convolve(self, name: str, profile: SpaceProfile) -> None:
        stereo = name in self.responses
        impulse = self._impulse(name, profile)
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
                signal = block.mean(axis=1, keepdims=True) if stereo else block
                wet = oaconvolve(signal, impulse, mode="full", axes=0).astype("float32")
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
        # Unit-energy noise impulses do not preserve Wet/Dry for colored vocals.
        gain = (
            profile.reverb_gain * math.sqrt(dry_energy / max(wet_energy, 1e-20))
            if profile.reverb_gain
            else 1.0
        )
        self.limits[name] = 0.5 * dry_peak / max(wet_peak, 1e-12)
        self.gains[name] = min(gain, self.limits[name])

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
            "diffuseField": self.field_calibration,
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
                if gain > 0
            },
            "calibration": {
                "measuredOutputWetToDryDb": ratio(wet, dry),
                "activeWetToDryDb": ratio(active_wet, active_dry),
                "measuredOutputPeak": peak,
                "audibilityVerified": False,
                "estimatedSpatialEffect": True,
            },
        }
