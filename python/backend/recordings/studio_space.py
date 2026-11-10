from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf
from scipy.ndimage import median_filter
from scipy.signal import butter, find_peaks, resample_poly, sosfilt, oaconvolve

from backend.recordings.studio_audio import MasterRenderer, _check_cancel
from backend.domain_errors import DependencyError


@dataclass(frozen=True, slots=True)
class SpaceProfile:
    delay_seconds: float = 0
    delay_gain: float = 0
    delay_support: float = 0
    decay_seconds: float = 0
    reverb_gain: float = 0
    decay_count: int = 0
    stereo_width: float = 0.0
    effect_type: str = "none"


def apply_reference_space(
    renderer: MasterRenderer,
    reference: Path,
    recorded: Path,
    voice: Path,
    target: Path,
    cancel: threading.Event,
) -> dict[str, object]:
    expected = analyze_space(reference, cancel)
    existing = analyze_space(recorded, cancel)
    selected = match_space(expected, existing)
    method = "reference-cepstrum-pause-decay-and-stereo"
    if not (selected.delay_gain or selected.reverb_gain):
        # A separated reference often has no isolated pauses, so absence of
        # measurable tails is NOT evidence that the production is dry.
        # Estimate only a bounded room impression; do not invent an echo.
        width = _reference_width(reference, cancel)
        recorded_width = _reference_width(recorded, cancel)
        if width > recorded_width + 0.025:
            selected = SpaceProfile(
                decay_seconds=float(np.clip(0.28 + 0.45 * width, 0.28, 0.65)),
                reverb_gain=float(np.clip(0.12 + 0.12 * (width - recorded_width), 0.12, 0.20)),
                stereo_width=width,
                effect_type="subtle-room",
            )
            method = "reference-width-informed-room"
    # When isolated reference tails cannot be measured, infer a restrained
    # ambience from stereo width. A short, quiet early reflection is not
    # claimed as a detected slapback; it merely preserves spatial impression.
    if not (selected.delay_gain or selected.reverb_gain):
        reference_width = expected.stereo_width
        recorded_width = existing.stereo_width
        if reference_width > recorded_width + 0.035:
            difference = min(0.7, reference_width - recorded_width)
            selected = SpaceProfile(
                delay_seconds=0.075,
                delay_gain=float(np.clip(0.035 + 0.09 * difference, 0.035, 0.10)),
                decay_seconds=float(np.clip(0.30 + 0.55 * reference_width, 0.30, 0.72)),
                reverb_gain=float(np.clip(0.12 + 0.14 * difference, 0.12, 0.22)),
                stereo_width=reference_width,
                effect_type="width-guided-early-reflections",
            )
            method = "width-guided-ambience-not-detected-delay"
    applied = bool(selected.delay_gain or selected.reverb_gain)
    if applied:
        info = sf.info(voice)
        impulse = target.with_suffix(".ir.wav")
        write_impulse(selected, impulse, info.samplerate, info.channels)
        wet_stats = _render_separate_buses(renderer, voice, target, cancel, selected, reference=reference, recorded=recorded)

    return {
        "method": method,
        "effectDetection": {"delay": expected.effect_type if expected.delay_gain else "not-confident", "delayConfidence": expected.delay_support, "reverbEvidenceCount": expected.decay_count, "referenceStereoWidth": expected.stereo_width, "recordedStereoWidth": existing.stereo_width},
        "status": "matched" if applied else "no-supported-addition",
        "estimatedNotDetected": method == "width-guided-ambience-not-detected-delay",
        "reference": asdict(expected),
        "recorded": asdict(existing),
        "applied": asdict(selected),
        "wetBalance": wet_stats if applied else None,
    }




def _render_separate_buses(
    renderer: MasterRenderer,
    voice: Path,
    target: Path,
    cancel: threading.Event,
    profile: SpaceProfile,
    *,
    reference: Path | None = None,
    recorded: Path | None = None,
) -> dict[str, object]:
    """Render early reflections, delay and reverb independently, then mix once.

    The dry vocal is copied at unity. Each bus is measured against *active*
    vocal frames and is gain-limited independently; silence cannot inflate wet
    gain. Side effects are ducked gently while the singer is active.
    """
    info = sf.info(voice)
    bus_specs = {
        "early": SpaceProfile(),
        "echo": SpaceProfile(delay_seconds=profile.delay_seconds,
                             delay_gain=profile.delay_gain,
                             stereo_width=profile.stereo_width),
        "reverb": SpaceProfile(decay_seconds=profile.decay_seconds,
                               reverb_gain=profile.reverb_gain,
                               stereo_width=profile.stereo_width),
    }
    if profile.effect_type not in ("slapback", "delay", "width-guided-early-reflections"):
        bus_specs["early"] = SpaceProfile()
    bus_specs = {name: spec for name, spec in bus_specs.items()
                 if spec.delay_gain or spec.reverb_gain}
    if not bus_specs:
        return {"buses": {}, "status": "no-effects"}
    target_db, evidence = _reference_wet_target(reference, recorded, cancel)
    # A stereo-width proxy is not a measurement of separate FX levels.
    # Use it only to adjust the total budget; retain independent per-bus caps.
    total_db = float(np.clip(target_db if target_db is not None else -13.0, -18.0, -9.0))
    allocations = {"early": -8.0, "echo": -4.0, "reverb": -5.0}
    wet_paths: dict[str, Path] = {}
    impulse_paths: list[Path] = []
    try:
        for name, spec in bus_specs.items():
            impulse = target.with_name(target.stem + f".{name}.ir.wav")
            rendered = target.with_name(target.stem + f".{name}.wet.tmp.wav")
            impulse_paths.append(impulse)
            write_impulse(spec, impulse, info.samplerate, info.channels)
            # Streaming overlap-add convolution with a wet-only impulse.
            # This avoids AFIR dry/wet ambiguity and guarantees unity dry.
            ir, _ = sf.read(impulse, dtype="float32", always_2d=True)
            ir[0] = 0.0
            with sf.SoundFile(voice) as src, sf.SoundFile(
                rendered, "w", samplerate=info.samplerate,
                channels=info.channels, subtype="FLOAT"
            ) as out:
                overlap = np.zeros((max(0, len(ir) - 1), info.channels), dtype="float32")
                while True:
                    _check_cancel(cancel)
                    block = src.read(32768, dtype="float32", always_2d=True)
                    if not len(block):
                        break
                    convolved = np.stack([
                        oaconvolve(block[:, channel], ir[:, channel], mode="full")
                        for channel in range(info.channels)
                    ], axis=1).astype("float32")
                    # Carry the full convolution tail across blocks, including
                    # when the impulse is longer than the current input block.
                    if len(overlap) > len(convolved):
                        convolved = np.pad(convolved, ((0, len(overlap) - len(convolved)), (0, 0)))
                    if len(overlap):
                        convolved[:len(overlap)] += overlap
                    out.write(convolved[:len(block)])
                    overlap = convolved[len(block):].copy()
            wet_paths[name] = rendered
        names = list(wet_paths)
        with sf.SoundFile(voice) as dry:
            sources = {name: sf.SoundFile(path) for name, path in wet_paths.items()}
            try:
                for src in sources.values():
                    if (src.frames, src.channels, src.samplerate) != (info.frames, info.channels, info.samplerate):
                        raise DependencyError("StudioMasterWetMismatch", "Spatial bus format mismatch")
                dry_energy = 0.0
                wet_energy = {name: 0.0 for name in names}
                wet_peak = {name: 0.0 for name in names}
                dry_peak = 0.0
                while True:
                    _check_cancel(cancel)
                    a = dry.read(32768, dtype="float32", always_2d=True)
                    if not len(a):
                        break
                    active = np.mean(a.astype(np.float64) ** 2, axis=1) > 1e-6
                    if np.any(active):
                        dry_energy += float(np.sum(a[active].astype(np.float64) ** 2))
                        dry_peak = max(dry_peak, float(np.max(np.abs(a[active]))))
                    for name, src in sources.items():
                        b = src.read(len(a), dtype="float32", always_2d=True)
                        if not np.isfinite(b).all():
                            raise DependencyError("StudioMasterInvalidWet", "Invalid spatial bus samples")
                        if np.any(active):
                            wet_energy[name] += float(np.sum(b[active].astype(np.float64) ** 2))
                        wet_peak[name] = max(wet_peak[name], float(np.max(np.abs(b))))
            finally:
                for src in sources.values():
                    src.close()
        gains = {}
        for name in names:
            goal = 10 ** ((total_db + allocations[name]) / 20)
            gains[name] = float(min(
                3.0,
                goal * math.sqrt(dry_energy / max(wet_energy[name], 1e-20)),
                0.35 * max(dry_peak, 1e-6) / max(wet_peak[name], 1e-9),
            )) if dry_energy > 1e-12 and wet_energy[name] > 1e-15 else 0.0
        # A measured side-energy target is only a proxy for spatial ambience.
        # Calibrate after summing the three wet buses, not from IR gains alone.
        # This prevents correlated buses from unexpectedly cancelling or stacking.
        def measure_mix_side(scale: float) -> tuple[float, float]:
            mid_energy = side_energy = 0.0
            with sf.SoundFile(voice) as dry_source:
                readers = {name: sf.SoundFile(path) for name, path in wet_paths.items()}
                try:
                    while True:
                        _check_cancel(cancel)
                        a = dry_source.read(32768, dtype="float32", always_2d=True)
                        if not len(a):
                            break
                        wet_block = np.zeros_like(a)
                        for name, reader in readers.items():
                            wet_block += reader.read(len(a), dtype="float32", always_2d=True) * gains[name]
                        # Use the same conservative activity attenuation as the render.
                        mixed = a + wet_block * scale * 0.7
                        if mixed.shape[1] >= 2:
                            mid = (mixed[:, 0].astype(np.float64) + mixed[:, 1]) * 0.5
                            side = (mixed[:, 0].astype(np.float64) - mixed[:, 1]) * 0.5
                            mid_energy += float(np.dot(mid, mid))
                            side_energy += float(np.dot(side, side))
                finally:
                    for reader in readers.values():
                        reader.close()
            return (math.sqrt(side_energy / max(mid_energy, 1e-20)), mid_energy)

        target_side, side_evidence = (None, "not-calibrated")
        if reference is not None and info.channels >= 2:
            ratio, count = _stereo_side_ratio(reference, cancel)
            if count >= 4:
                target_side, side_evidence = ratio, "reference-side-proxy"
        scale = 1.0
        if target_side is not None:
            # Only a bounded correction: stereo side energy is not a true
            # reference wet stem, and may include doubles or source artifacts.
            candidates = (0.6, 0.8, 1.0, 1.25, 1.5)
            estimates = [(candidate, measure_mix_side(candidate)[0]) for candidate in candidates]
            scale = min(estimates, key=lambda item: abs(item[1] - target_side))[0]
        gains = {name: gain * scale for name, gain in gains.items()}
        measured_side, _ = measure_mix_side(1.0)

        with sf.SoundFile(voice) as dry, sf.SoundFile(
            target, "w", samplerate=info.samplerate,
            channels=info.channels, subtype="FLOAT"
        ) as out:
            sources = {name: sf.SoundFile(path) for name, path in wet_paths.items()}
            try:
                # State is continuous across blocks: no abrupt effect changes.
                envelope = 0.0
                smoothing = math.exp(-1 / (0.12 * info.samplerate))
                for _ in range(0, info.frames, 16384):
                    _check_cancel(cancel)
                    a = dry.read(16384, dtype="float32", always_2d=True)
                    if not len(a):
                        break
                    wet = np.zeros_like(a)
                    # A slow activity envelope makes effects quieter *during*
                    # words and lets tails bloom naturally after each phrase.
                    mono = np.sqrt(np.mean(a.astype(np.float64) ** 2, axis=1))
                    duck = np.empty(len(a), dtype=np.float32)
                    for i, level in enumerate(mono):
                        envelope = smoothing * envelope + (1 - smoothing) * float(level)
                        duck[i] = 1.0 - 0.30 * min(1.0, envelope / 0.025)
                    for name, src in sources.items():
                        b = src.read(len(a), dtype="float32", always_2d=True)
                        wet += b * (gains[name] * duck[:, None])
                    out.write(a + wet)
            finally:
                for src in sources.values():
                    src.close()
        report = {
            "version": 1,
            "referenceSideRatio": target_side,
            "measuredPreDeliverySideRatio": measured_side,
            "calibrationEvidence": side_evidence,
            "calibrationScale": scale,
            "wetBuses": {name: {
                "gainDb": round(20 * math.log10(max(gains[name], 1e-12)), 2),
                "activeWetToDryDb": round(10 * math.log10(max(wet_energy[name] * gains[name] ** 2, 1e-20) / max(dry_energy, 1e-20)), 2),
                "wetPeakBeforeGain": wet_peak[name],
            } for name in names},
            "note": "Stereo ratio is a proxy, not isolated reverb or delay energy; measured before final delivery",
        }
        return {"status": "rendered", "referenceMethod": evidence,
                "calibration": report,
                "totalBudgetDb": total_db,
                "buses": {name: {"gainDb": round(20 * math.log10(max(gains[name], 1e-12)), 2),
                                  "targetActiveRmsDb": round(total_db + allocations[name], 2)}
                          for name in names}, "dryPreserved": True}
    finally:
        for path in [*wet_paths.values(), *impulse_paths]:
            path.unlink(missing_ok=True)

def _render_bounded_space(
    renderer: MasterRenderer,
    voice: Path,
    impulse: Path,
    target: Path,
    cancel: threading.Event,
    reference_width: float = 0.0,
    effect_type: str = "none",
    *,
    reference: Path | None = None,
    recorded: Path | None = None,
) -> dict[str, float | str]:
    """Mix true wet-only convolution with unchanged dry voice.

    An impulse's gain does not directly bound AFIR output level. Measure the
    actual convolution and apply a *constant* attenuation, preventing pumping
    and ensuring the direct vocal is never lowered by spatial processing.
    """
    info = sf.info(voice)
    wet_path = target.with_name(target.stem + ".wet.tmp.wav")
    try:
        renderer._mix(
            voice, impulse,
            "[0:a][1:a]afir=dry=1:wet=1:irnorm=-1:irgain=1,"
            f"apad,atrim=end_sample={info.frames}[out]",
            ["-c:a", "pcm_f32le", str(wet_path)], cancel,
        )
        dry_energy = wet_energy = dry_peak = wet_peak = 0.0
        frames = 0
        with sf.SoundFile(voice) as dry, sf.SoundFile(wet_path) as wet:
            if (dry.frames != wet.frames or dry.channels != wet.channels
                    or dry.samplerate != wet.samplerate):
                raise DependencyError("StudioMasterWetMismatch", "Spatial effects format mismatch")
            while True:
                _check_cancel(cancel)
                a = dry.read(65536, dtype="float32", always_2d=True)
                if not len(a):
                    break
                b = wet.read(len(a), dtype="float32", always_2d=True)
                b = b - a  # AFIR output minus its unity dry path = wet-only signal
                if not np.isfinite(b).all():
                    raise DependencyError("StudioMasterInvalidWet", "Invalid spatial effects audio")
                dry_energy += float(np.sum(a.astype(np.float64) ** 2))
                wet_energy += float(np.sum(b.astype(np.float64) ** 2))
                dry_peak = max(dry_peak, float(np.max(np.abs(a))))
                wet_peak = max(wet_peak, float(np.max(np.abs(b))))
                frames += a.size
        # The reference is already processed: mid/side energy is only an
        # *upper-bound proxy* for stereo effects, not a true dry/wet stem.
        # Compare it with the existing recording to avoid counting its own
        # stereo content as a missing effect. No arbitrary width->dB formula.
        target_db, evidence = _reference_wet_target(reference, recorded, cancel)
        if target_db is None:
            target_db = -14.0  # explicitly labeled fallback, not reference matching
        rms_ratio = 10 ** (target_db / 20)
        # Allow boosting a weak rendered effect (the previous <=1 clamp made
        # this impossible), but cap total gain and transients independently.
        peak_ratio = 10 ** (-5 / 20)
        gain = min(
            4.0,
            rms_ratio * (dry_energy / max(wet_energy, 1e-20)) ** 0.5,
            peak_ratio * dry_peak / max(wet_peak, 1e-10),
        ) if dry_energy > 1e-12 and wet_energy > 1e-18 else 0.0
        with (sf.SoundFile(voice) as dry, sf.SoundFile(wet_path) as wet,
              sf.SoundFile(target, "w", samplerate=info.samplerate,
                           channels=info.channels, subtype="FLOAT") as out):
            while True:
                _check_cancel(cancel)
                a = dry.read(65536, dtype="float32", always_2d=True)
                if not len(a):
                    break
                b = wet.read(len(a), dtype="float32", always_2d=True)
                out.write(a + (b - a) * gain)
        return {"wetTargetRmsDb": target_db, "wetGainDb": float(20 * math.log10(max(gain, 1e-12))),
                "wetToDryRmsDb": float(10 * math.log10(max(wet_energy * gain * gain, 1e-20) / max(dry_energy, 1e-20))),
                "dryPreserved": True, "targetMethod": evidence}
    finally:
        wet_path.unlink(missing_ok=True)

def _stereo_side_ratio(path: Path, cancel: threading.Event) -> tuple[float, int]:
    """Median active-block side/mid RMS ratio; no whole-song memory load."""
    ratios: list[float] = []
    with sf.SoundFile(path) as source:
        if source.channels < 2:
            return 0.0, 0
        for index, block in enumerate(source.blocks(
            blocksize=source.samplerate, dtype="float32", always_2d=True
        )):
            _check_cancel(cancel)
            if index >= 180:
                break
            left, right = block[:, 0].astype(np.float64), block[:, 1].astype(np.float64)
            mid = (left + right) * 0.5
            side = (left - right) * 0.5
            mid_power = float(np.mean(mid * mid))
            if mid_power < 1e-7:
                continue
            ratios.append(math.sqrt(float(np.mean(side * side)) / mid_power))
    return (float(np.median(ratios)), len(ratios)) if ratios else (0.0, 0)


def _reference_wet_target(
    reference: Path | None, recorded: Path | None, cancel: threading.Event
) -> tuple[float | None, str]:
    """Conservative reference-derived *stereo ambience* target.

    The original dry stem is unavailable. Side energy also includes doubles,
    panning and separation artifacts, so do not claim to measure true wet/dry.
    Mono/low-evidence material uses a safe fallback instead.
    """
    if reference is None or recorded is None:
        return None, "fallback-no-reference"
    ref_ratio, ref_count = _stereo_side_ratio(reference, cancel)
    rec_ratio, rec_count = _stereo_side_ratio(recorded, cancel)
    if min(ref_count, rec_count) < 4:
        return None, "fallback-insufficient-stereo-evidence"
    additional = math.sqrt(max(0.0, ref_ratio**2 - rec_ratio**2))
    if additional < 0.035:
        return None, "fallback-no-reliable-additional-side-energy"
    # Calibrate only within a conservative range. The estimate is a proxy,
    # not a claim that the separated reference contains a clean wet stem.
    return float(np.clip(20 * math.log10(additional), -20.0, -9.0)), "reference-additional-side-energy-proxy"


def _reference_width(path: Path, cancel: threading.Event) -> float:
    """Robust stereo difference ratio from active blocks, bounded to [0, 1].

    Width alone cannot prove the presence or settings of a reverb. It is used
    only to choose a restrained fallback when direct tail evidence is absent.
    """
    values: list[float] = []
    with sf.SoundFile(path) as source:
        if source.channels < 2:
            return 0.0
        for index, samples in enumerate(source.blocks(
            blocksize=source.samplerate, dtype="float32", always_2d=True
        )):
            _check_cancel(cancel)
            if index >= 90:
                break
            left, right = samples[:, 0], samples[:, 1]
            power = float(np.mean(left * left + right * right))
            if power > 1e-7:
                difference = float(np.mean((left - right) ** 2))
                values.append(float(np.clip(difference / power, 0, 1)))
    return float(np.median(values)) if values else 0.0


def analyze_space(path: Path, cancel: threading.Event) -> SpaceProfile:
    levels, cepstra = _read_evidence(path, cancel)
    delay, gain, support = _delay(cepstra)
    decay, wet, count = _decay(levels)
    width = _reference_width(path, cancel)
    kind = ("slapback" if delay < 0.12 else "delay") if gain else "none"
    return SpaceProfile(delay, gain, support, decay, wet, count, width, kind)


def match_space(reference: SpaceProfile, existing: SpaceProfile) -> SpaceProfile:
    # Existing recorded tails cannot be shortened by adding another effect.
    reverb = (
        math.sqrt(max(0, reference.reverb_gain**2 - existing.reverb_gain**2))
        if existing.decay_seconds <= reference.decay_seconds
        else 0.0
    )
    return SpaceProfile(
        delay_seconds=reference.delay_seconds,
        delay_gain=float(np.clip(reference.delay_gain - existing.delay_gain, 0, 0.35)),
        delay_support=reference.delay_support,
        decay_seconds=reference.decay_seconds,
        reverb_gain=float(np.clip(reverb, 0, 0.35)),
        decay_count=reference.decay_count,
        stereo_width=reference.stereo_width,
        effect_type=reference.effect_type,
    )


def write_impulse(profile: SpaceProfile, path: Path, rate: int, channels: int) -> None:
    length = round((max(profile.decay_seconds, profile.delay_seconds, 0.02) + 0.02) * rate)
    impulse = np.zeros((length, channels), dtype=np.float64)
    # The dry voice is mixed separately by afir=dry=1. An impulse at t=0
    # would add a second, unprocessed copy and obscure the wet/dry balance.
    if profile.delay_gain:
        delay_index = round(profile.delay_seconds * rate)
        if 0 < delay_index < length:
            # Preserve the centered dry signal; place repeat energy in the sides.
            if channels >= 2 and profile.stereo_width > 0.08:
                impulse[delay_index, 0] += profile.delay_gain
                opposite = min(length - 1, delay_index + round(0.017 * rate))
                impulse[opposite, 1] += profile.delay_gain * 0.85
                if channels > 2:
                    impulse[delay_index, 2:] += profile.delay_gain * 0.5
            else:
                impulse[delay_index] += profile.delay_gain
    if profile.reverb_gain and profile.decay_seconds > 0:
        start = round(0.02 * rate)
        time = np.arange(length - start) / rate
        noise = np.random.default_rng(0).normal(size=(len(time), channels))
        band = butter(2, [180, min(6000, rate * 0.45)], btype="bandpass", fs=rate, output="sos")
        tail = sosfilt(band, noise, axis=0) * np.exp(
            -6.9078 * time[:, None] / profile.decay_seconds
        )
        tail /= np.maximum(np.linalg.norm(tail, axis=0), 1e-12)
        if channels >= 2 and profile.stereo_width > 0.08:
            # Independent diffuse tails widen only the wet component.
            tail[:, :2] *= min(1.0, 0.65 + profile.stereo_width)
        impulse[start:] += profile.reverb_gain * tail
    sf.write(path, impulse, rate, subtype="FLOAT")


def _read_evidence(path: Path, cancel: threading.Event) -> tuple[np.ndarray, np.ndarray]:
    levels: list[float] = []
    cepstra: list[np.ndarray] = []
    energies: list[float] = []
    with sf.SoundFile(path) as source:
        block = source.samplerate * 2
        stride = max(1, math.ceil(source.frames / block / 96))
        step = max(1, round(source.samplerate * 0.02))
        for index, samples in enumerate(source.blocks(blocksize=block, always_2d=True)):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            samples = samples[:, :2]
            usable = len(samples) // step * step
            if usable:
                power = np.mean(
                    samples[:usable].reshape(-1, step, samples.shape[1]) ** 2, axis=(1, 2)
                )
                levels.extend(10 * np.log10(np.maximum(power, 1e-12)))
            if index % stride == 0 and len(samples) == block:
                energies.append(float(np.mean(samples * samples)))
                cepstra.append(_cepstrum(samples, source.samplerate))
    if not energies:
        return np.asarray(levels), np.empty((0, 8193))
    active = np.asarray(energies) > max(1e-8, float(np.percentile(energies, 75)) / 100)
    return np.asarray(levels), np.asarray(cepstra)[active]


def _cepstrum(samples: np.ndarray, rate: int) -> np.ndarray:
    divisor = math.gcd(rate, 8000)
    audio = resample_poly(samples, 8000 // divisor, rate // divisor, axis=0)
    # A tapered window changes the direct/echo ratio at different delays.
    # Use untapered blocks and require the peak to persist across independent blocks.
    spectrum = np.abs(np.fft.rfft(audio, n=16384, axis=0))
    logarithm = np.log(np.maximum(spectrum, np.max(spectrum) * 1e-8 + 1e-12))
    return np.mean(np.fft.irfft(logarithm, n=16384, axis=0), axis=1)[:8193]


def _delay(cepstra: np.ndarray) -> tuple[float, float, float]:
    if len(cepstra) < 6:
        return 0, 0, 0
    # Persistent long-quefrency peaks indicate a delayed copy, not vocal pitch.
    curve = np.median(cepstra, axis=0)
    # 40–600 ms: include short slapback while excluding the voiced pitch region.
    lower, upper = 320, 4800
    noise = float(np.median(np.abs(curve[lower:upper])))
    peaks, _ = find_peaks(curve[lower:upper], height=max(0.015, noise * 10), distance=80)
    if not len(peaks):
        return 0, 0, 0
    index = int(peaks[np.argmax(curve[lower:upper][peaks])] + lower)
    agreeing = cepstra[:, index] > max(0.01, noise * 6)
    support = float(np.mean(agreeing))
    if support < 0.7:
        return 0, 0, support
    seconds = index / 8000
    # A block boundary can cut off a repeat. Estimate strength from the upper
    # quartile of agreeing blocks, rather than treating cut tails as a quieter effect.
    gain = float(np.clip(2 * np.percentile(cepstra[agreeing, index], 75), 0, 0.30))
    return seconds, gain, support


def _decay(levels: np.ndarray) -> tuple[float, float, int]:
    if len(levels) < 150 or np.percentile(levels, 80) - np.percentile(levels, 10) < 15:
        return 0, 0, 0
    smooth = median_filter(levels, size=3)
    floor = max(-85.0, float(np.percentile(smooth, 10)) + 6)
    candidates = np.flatnonzero(smooth[:-2] - smooth[2:] > 5) + 2
    evidence = []
    previous = -50
    for index in candidates:
        if index < 12 or index - previous < 50:
            continue
        fit = _fit_decay(smooth, int(index), floor)
        if fit is not None:
            evidence.append(fit)
            previous = int(index)
    if len(evidence) < 3:
        return 0, 0, len(evidence)
    decays, gains = np.asarray(evidence).T
    consistent = np.abs(np.log(decays / np.median(decays))) < 0.4
    if np.count_nonzero(consistent) < 3:
        return 0, 0, len(evidence)
    return float(np.median(decays[consistent])), float(np.median(gains[consistent])), len(evidence)


def _fit_decay(levels: np.ndarray, index: int, floor: float) -> tuple[float, float] | None:
    tail = levels[index : index + 60]
    stops = np.flatnonzero((tail < floor) | (tail > tail[0] + 3))
    if len(stops):
        tail = tail[: stops[0]]
    if len(tail) < 7 or tail[0] - tail[-1] < 10:
        return None
    time = np.arange(len(tail)) * 0.02
    slope, intercept = np.polyfit(time, tail, 1)
    fitted = intercept + slope * time
    error = float(np.sum((tail - fitted) ** 2) / max(1e-12, np.sum((tail - np.mean(tail)) ** 2)))
    if error > 0.15 or not -300 <= slope <= -25:
        return None
    active = float(np.median(levels[index - 12 : index - 2]))
    strength = float(np.clip(10 ** ((intercept - active) / 20), 0, 0.5))
    return float(-60 / slope), strength


def apply_fallback_space(
    renderer: MasterRenderer, voice: Path, backing: Path, target: Path, cancel: threading.Event
) -> dict[str, object]:
    """Add subtle room coherence only when the reference offers no usable space cues.

    This is a deterministic, low-wet, peak-safe fallback, not an inferred
    reconstruction of the original singer's room.
    """
    with sf.SoundFile(backing) as music:
        rate = music.samplerate
        # Use only the original stereo pair; duplicate surround channels are
        # not independent evidence of spatial width.
        width = []
        for index, block in enumerate(music.blocks(blocksize=rate, always_2d=True)):
            _check_cancel(cancel)
            if index >= 20:
                break
            if block.shape[1] < 2:
                continue
            left, right = block[:, 0], block[:, 1]
            power = float(np.mean(left * left + right * right))
            if power > 1e-9:
                width.append(float(np.mean((left - right) ** 2) / power))
    stereo_width = float(np.median(width)) if width else 0.0
    # Mono/dry backing: short ambience. Wide backing: slightly longer tail.
    decay = float(np.clip(0.22 + stereo_width * 0.25, 0.22, 0.48))
    strength = 0.08 if stereo_width < 0.08 else 0.12
    info = sf.info(voice)
    profile = SpaceProfile(decay_seconds=decay, reverb_gain=strength, decay_count=0)
    impulse = target.with_suffix(".ir.wav")
    write_impulse(profile, impulse, info.samplerate, info.channels)
    wet_stats = _render_separate_buses(renderer, voice, target, cancel, profile)
    return {"method": "bounded-room-fallback", "decaySeconds": decay,
            "wetImpulseGain": strength, "backingStereoWidth": stereo_width,
            "wetBalance": wet_stats}
