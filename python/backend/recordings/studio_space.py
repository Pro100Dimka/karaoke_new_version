from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import math
import threading

import numpy as np
import soundfile as sf
from scipy.ndimage import median_filter
from scipy.signal import butter, find_peaks, resample_poly, sosfilt, oaconvolve, lfilter

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
    # Stereo width is not evidence of a discrete echo. Never synthesize a
    # fixed-delay repeat when the reference contains no supported repetition.
    # Width-only material can still receive the reference-informed diffuse room
    # selected above; the report distinguishes this from a measured reverb.
    applied = bool(selected.delay_gain or selected.reverb_gain)
    # The caller always expects target to exist, including when the reference
    # contains no trustworthy evidence of spatial processing.
    wet_stats = _render_separate_buses(
        renderer, voice, target, cancel, selected,
        reference=reference if applied else None,
        recorded=recorded if applied else None,
    )

    return {
        "method": method,
        "effectDetection": {"delay": expected.effect_type if expected.delay_gain else "not-confident", "delayConfidence": expected.delay_support, "reverbEvidenceCount": expected.decay_count, "referenceStereoWidth": expected.stereo_width, "recordedStereoWidth": existing.stereo_width},
        "status": "matched" if applied else "no-supported-addition",
        "estimatedNotDetected": method == "reference-width-informed-room",
        "reference": asdict(expected),
        "recorded": asdict(existing),
        "applied": asdict(selected),
        "wetBalance": wet_stats if applied else None,
    }




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
                frames = samples[:count * window].reshape(count, window, source.channels)
                rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=(1, 2)))
                valid = rms[rms > 1e-7]
                if len(valid):
                    indices = np.clip(((20 * np.log10(valid) + 120) * (127 / 120)).astype(int), 0, 127)
                    histogram += np.bincount(indices, minlength=128)
            pending = samples[count * window:]
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
        [1.0 - smoothing], [1.0, -smoothing], amplitude,
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
) -> dict[str, object]:
    """Render early reflections, delay and reverb independently, then mix once.

    The dry vocal is copied at unity. Each bus is measured against *active*
    vocal frames and is gain-limited independently; silence cannot inflate wet
    gain. Side effects are ducked gently while the singer is active.
    """
    info = sf.info(voice)
    activity_level = _voice_activity_level(voice, cancel)
    bus_specs = {
        "early": SpaceProfile(),
        "echo": SpaceProfile(delay_seconds=profile.delay_seconds,
                             delay_gain=profile.delay_gain,
                             stereo_width=profile.stereo_width),
        "reverb": SpaceProfile(decay_seconds=profile.decay_seconds,
                               reverb_gain=profile.reverb_gain,
                               stereo_width=profile.stereo_width),
    }
    # No artificial early-reflection bus: only render evidence-backed effects.
    bus_specs = {name: spec for name, spec in bus_specs.items()
                 if spec.delay_gain or spec.reverb_gain}
    if not bus_specs:
        # Always produce a valid output, including for dry references.
        with sf.SoundFile(voice) as src, sf.SoundFile(
            target, "w", samplerate=info.samplerate,
            channels=info.channels, subtype="FLOAT"
        ) as dst:
            for block in src.blocks(blocksize=32768, dtype="float32", always_2d=True):
                _check_cancel(cancel)
                dst.write(block)
        return {"buses": {}, "status": "no-effects", "dryPreserved": True}
    target_db, evidence = _reference_wet_target(reference, recorded, cancel)
    # A stereo-width proxy is not a measurement of separate FX levels.
    # Use it only to adjust the total budget; retain independent per-bus caps.
    total_db = float(np.clip(target_db if target_db is not None else -13.0, -18.0, -9.0))
    # Allocate the available wet energy from the measured reference profile,
    # rather than assigning identical echo/reverb priorities to every song.
    # IR strength is a relative cue only; each rendered bus is calibrated below.
    reference_strength = {
        "early": max(0.0, float(profile.delay_gain)) if profile.effect_type == "width-guided-early-reflections" else 0.0,
        "echo": max(0.0, float(profile.delay_gain)),
        "reverb": max(0.0, float(profile.reverb_gain)),
    }
    active_strength = {name: reference_strength[name] for name in bus_specs}
    strength_sum = sum(value * value for value in active_strength.values())
    # If no trustworthy relative level exists, do not invent a hierarchy.
    allocations = {
        name: (value * value / strength_sum if strength_sum > 0 else 1.0 / len(bus_specs))
        for name, value in active_strength.items()
    }
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
                activity_state = 0.0
                envelope = 0.0
                smoothing = math.exp(-1 / (0.12 * info.samplerate))
                while True:
                    _check_cancel(cancel)
                    a = dry.read(32768, dtype="float32", always_2d=True)
                    if not len(a):
                        break
                    active, activity_state = _activity_mask(
                        a, info.samplerate, activity_level, activity_state
                    )
                    # Calibrate the signal actually mixed into the output.
                    # The old measurement used the unducked bus, then reduced
                    # it during rendering, systematically under-shooting Wet.
                    mono = np.sqrt(np.mean(a.astype(np.float64) ** 2, axis=1))
                    filtered, _ = lfilter(
                        [1.0 - smoothing], [1.0, -smoothing], mono,
                        zi=[smoothing * envelope],
                    )
                    envelope = float(filtered[-1])
                    duck = 1.0 - 0.30 * np.minimum(
                        1.0, filtered / max(activity_level, 1e-7)
                    )
                    if np.any(active):
                        dry_energy += float(np.sum(a[active].astype(np.float64) ** 2))
                        dry_peak = max(dry_peak, float(np.max(np.abs(a[active]))))
                    for name, src in sources.items():
                        b = src.read(len(a), dtype="float32", always_2d=True)
                        if not np.isfinite(b).all():
                            raise DependencyError("StudioMasterInvalidWet", "Invalid spatial bus samples")
                        effective = b.astype(np.float64) * duck[:, None]
                        if np.any(active):
                            wet_energy[name] += float(np.sum(effective[active] ** 2))
                        wet_peak[name] = max(wet_peak[name], float(np.max(np.abs(effective))))
            finally:
                for src in sources.values():
                    src.close()
        gains = {}
        for name in names:
            goal = 10 ** (total_db / 20) * math.sqrt(allocations[name])
            # Calibrate from measured wet energy, not an arbitrary gain cap.
            # A normalized convolution IR can produce a quiet bus that needs
            # more than 3x amplification to meet the reference-derived goal.
            # Retain the peak-based safety bound so this cannot create huge
            # individual reflections relative to the actual dry vocal.
            gains[name] = float(min(
                goal * math.sqrt(dry_energy / max(wet_energy[name], 1e-20)),
                0.35 * max(dry_peak, 1e-6) / max(wet_peak[name], 1e-9),
            )) if dry_energy > 1e-12 and wet_energy[name] > 1e-15 else 0.0
        # Measure the exact Dry/Wet activity envelope used by the final render.
        # The previous implementation calibrated with a constant 0.7 multiplier,
        # although the real ducking varies sample-by-sample. It could therefore
        # select a gain that did not produce the predicted stereo width.
        target_side, side_evidence = (None, "not-calibrated")
        if reference is not None and info.channels >= 2:
            ratio, count = _stereo_side_ratio(reference, cancel)
            if count >= 4:
                target_side, side_evidence = ratio, "reference-side-proxy"

        scale = 1.0
        measured_side = None
        if info.channels >= 2:
            # Quadratic energy coefficients allow evaluating any wet gain without
            # rereading the song for every candidate. Only one streaming pass.
            mid_terms = np.zeros(3, dtype=np.float64)
            side_terms = np.zeros(3, dtype=np.float64)
            with sf.SoundFile(voice) as dry_source:
                readers = {name: sf.SoundFile(path) for name, path in wet_paths.items()}
                try:
                    envelope = 0.0
                    activity_state = 0.0
                    smoothing = math.exp(-1 / (0.12 * info.samplerate))
                    while True:
                        _check_cancel(cancel)
                        a = dry_source.read(16384, dtype="float32", always_2d=True)
                        if not len(a):
                            break
                        mono = np.sqrt(np.mean(a.astype(np.float64) ** 2, axis=1))
                        filtered, _ = lfilter(
                            [1.0 - smoothing], [1.0, -smoothing], mono,
                            zi=[smoothing * envelope],
                        )
                        envelope = float(filtered[-1])
                        duck = 1.0 - 0.30 * np.minimum(1.0, filtered / max(activity_level, 1e-7))
                        wet = np.zeros_like(a, dtype=np.float64)
                        for name, reader in readers.items():
                            wet += reader.read(len(a), dtype="float32", always_2d=True) * gains[name]
                        wet *= duck[:, None]
                        # Match the reference estimator: measure stereo energy
                        # only where the singer is active. Otherwise long quiet
                        # passages and noise dominate the optimization objective.
                        active, activity_state = _activity_mask(
                            a, info.samplerate, activity_level, activity_state
                        )
                        if not np.any(active):
                            continue
                        a = a[active]
                        wet = wet[active]
                        dmid = (a[:, 0].astype(np.float64) + a[:, 1]) * 0.5
                        dside = (a[:, 0].astype(np.float64) - a[:, 1]) * 0.5
                        wmid = (wet[:, 0] + wet[:, 1]) * 0.5
                        wside = (wet[:, 0] - wet[:, 1]) * 0.5
                        for terms, dry_component, wet_component in (
                            (mid_terms, dmid, wmid), (side_terms, dside, wside)
                        ):
                            terms[0] += float(np.dot(dry_component, dry_component))
                            terms[1] += float(2 * np.dot(dry_component, wet_component))
                            terms[2] += float(np.dot(wet_component, wet_component))
                finally:
                    for reader in readers.values():
                        reader.close()

            def predicted_side(wet_scale: float) -> float:
                powers = np.array([1.0, wet_scale, wet_scale * wet_scale])
                mid = max(float(np.dot(mid_terms, powers)), 1e-20)
                side = max(float(np.dot(side_terms, powers)), 0.0)
                return math.sqrt(side / mid)

            if target_side is not None and side_terms[2] > 1e-12:
                # Stereo side energy is only a proxy for ambience. Restrict the
                # adjustment rather than forcing an exact match to vocal doubles.
                from scipy.optimize import minimize_scalar
                result = minimize_scalar(
                    lambda candidate: (predicted_side(candidate) - target_side) ** 2,
                    bounds=(0.6, 1.5), method="bounded",
                    options={"xatol": 1e-3},
                )
                if result.success:
                    # Do not change an otherwise calibrated wet level unless
                    # the reference match genuinely improves. Some songs have
                    # stereo doubles or separation artefacts that no reverb
                    # gain can reproduce; forcing a boundary value only makes
                    # the effects quieter or louder without matching them.
                    candidate = float(result.x)
                    baseline_error = abs(predicted_side(1.0) - target_side)
                    candidate_error = abs(predicted_side(candidate) - target_side)
                    if candidate_error < baseline_error * 0.95:
                        scale = candidate
            measured_side = predicted_side(scale)
        gains = {name: gain * scale for name, gain in gains.items()}

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
                    filtered, _ = lfilter(
                        [1.0 - smoothing], [1.0, -smoothing], mono,
                        zi=[smoothing * envelope],
                    )
                    envelope = float(filtered[-1])
                    duck = (1.0 - 0.30 * np.minimum(1.0, filtered / max(activity_level, 1e-7))).astype(np.float32)
                    for name, src in sources.items():
                        b = src.read(len(a), dtype="float32", always_2d=True)
                        wet += b * (gains[name] * duck[:, None])
                    out.write(a + wet)
            finally:
                for src in sources.values():
                    src.close()
        # Verify the actual file, not merely the planned bus gains. This catches
        # a disconnected/muted wet path without loading the full recording.
        output_energy = 0.0
        difference_energy = 0.0
        output_peak = 0.0
        active_wet = active_dry = tail_wet = 0.0
        active_frames = tail_frames = 0
        with sf.SoundFile(voice) as original, sf.SoundFile(target) as rendered:
            if (original.frames, original.samplerate, original.channels) != (
                rendered.frames, rendered.samplerate, rendered.channels
            ):
                raise DependencyError("StudioMasterSpatialOutputMismatch", "Spatial output format mismatch")
            activity_state = 0.0
            while True:
                _check_cancel(cancel)
                dry_block = original.read(32768, dtype="float32", always_2d=True)
                if not len(dry_block):
                    break
                final_block = rendered.read(len(dry_block), dtype="float32", always_2d=True)
                if len(final_block) != len(dry_block) or not np.isfinite(final_block).all():
                    raise DependencyError("StudioMasterInvalidSpatialOutput", "Invalid spatial output")
                dry64 = dry_block.astype(np.float64)
                difference = final_block.astype(np.float64) - dry64
                output_energy += float(np.sum(dry64 ** 2))
                difference_energy += float(np.sum(difference ** 2))
                output_peak = max(output_peak, float(np.max(np.abs(final_block))))
                active, activity_state = _activity_mask(
                    dry_block, info.samplerate, activity_level, activity_state
                )
                if np.any(active):
                    active_wet += float(np.sum(difference[active] ** 2))
                    active_dry += float(np.sum(dry64[active] ** 2))
                    active_frames += int(np.count_nonzero(active))
                if np.any(~active):
                    tail_wet += float(np.sum(difference[~active] ** 2))
                    tail_frames += int(np.count_nonzero(~active))
        applied_wet_db = (10 * math.log10(difference_energy / output_energy)
                          if output_energy > 1e-20 and difference_energy > 0 else None)
        if any(gain > 0 for gain in gains.values()) and applied_wet_db is None:
            raise DependencyError("StudioMasterSilentSpatialEffects", "Spatial effects produced no output signal")
        # Compute active and unvoiced diagnostics in the same streaming pass
        # as output validation, avoiding a second complete WAV read.
        active_ratio = (10 * math.log10(active_wet / active_dry)
                        if active_dry > 1e-20 and active_wet > 0 else None)
        tail_rms_dbfs = (10 * math.log10(tail_wet / (tail_frames * info.channels))
                         if tail_frames and tail_wet > 0 else None)
        report = {
            "version": 4,
            "measuredVocalActivityLevelDbfs": (round(20 * math.log10(activity_level), 2) if activity_level > 0 else None),
            "measuredOutputWetToDryDb": round(applied_wet_db, 2) if applied_wet_db is not None else None,
            "measuredOutputPeak": output_peak,
            "activeWetToDryDb": round(active_ratio, 2) if active_ratio is not None else None,
            "unvoicedWetRmsDbfs": round(tail_rms_dbfs, 2) if tail_rms_dbfs is not None else None,
            "voicedFramesMeasured": active_frames,
            "unvoicedFramesMeasured": tail_frames,
            "audibilityVerified": False,  # signal energy alone cannot establish perceptual audibility

            "referenceSideRatio": target_side,
            "measuredPreDeliverySideRatio": measured_side,
            "calibrationEvidence": side_evidence,
            "calibrationScale": scale,
            "wetBuses": {name: {
                "gainDb": round(20 * math.log10(max(gains[name], 1e-12)), 2),
                "activeWetToDryDb": round(10 * math.log10(max(wet_energy[name] * gains[name] ** 2, 1e-20) / max(dry_energy, 1e-20)), 2),
                "wetPeakAfterDuckingBeforeGain": wet_peak[name],
                "gainLimitedByPeak": bool(
                    dry_energy > 1e-12 and wet_energy[name] > 1e-15
                    and 0.35 * max(dry_peak, 1e-6) / max(wet_peak[name], 1e-9)
                    < 10 ** (total_db / 20) * math.sqrt(allocations[name])
                    * math.sqrt(dry_energy / max(wet_energy[name], 1e-20))
                ),
            } for name in names},
            "note": "Stereo ratio is a proxy, not isolated reverb or delay energy; measured before final delivery",
        }
        return {"status": "rendered", "referenceMethod": evidence,
                "calibration": report,
                "totalBudgetDb": total_db,
                "referenceBusEnergyShares": allocations,
                "buses": {name: {"gainDb": round(20 * math.log10(max(gains[name], 1e-12)), 2),
                                  "targetActiveRmsDb": round(total_db + 10 * math.log10(max(allocations[name], 1e-12)), 2)}
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
    """Stereo side/mid ratio measured on active vocal passages.

    Silence and quiet separation artifacts must not determine the target space.
    The active threshold comes from the recording's own RMS distribution, not
    a global dBFS constant. Return zero evidence for effectively silent files.
    """
    windows: list[tuple[float, float]] = []
    with sf.SoundFile(path) as source:
        if source.channels < 2:
            return 0.0, 0
        for block in source.blocks(
            blocksize=max(1, source.samplerate // 2), dtype="float32", always_2d=True
        ):
            _check_cancel(cancel)
            left = block[:, 0].astype(np.float64)
            right = block[:, 1].astype(np.float64)
            mid = (left + right) * 0.5
            side = (left - right) * 0.5
            mid_power = float(np.mean(mid * mid))
            side_power = float(np.mean(side * side))
            windows.append((mid_power, side_power))
    if not windows:
        return 0.0, 0
    powers = np.asarray(windows, dtype=np.float64)
    active_powers = powers[:, 0]
    if not np.any(active_powers > 1e-12):
        return 0.0, 0
    # Gate relative to the actual vocal energy, avoiding silence/bleed bias.
    threshold = float(np.percentile(active_powers[active_powers > 1e-12], 70)) * 0.1
    active = powers[(active_powers >= threshold) & (active_powers > 1e-12)]
    if not len(active):
        return 0.0, 0
    ratios = np.sqrt(active[:, 1] / active[:, 0])
    return float(np.median(ratios)), len(ratios)


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
        for samples in source.blocks(
            blocksize=source.samplerate, dtype="float32", always_2d=True
        ):
            _check_cancel(cancel)
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
    # Subtract existing echo only when it is the *same* measured repeat.
    # Previously an unrelated short reflection could cancel the reference
    # delay entirely, leaving the mastered vocal without the desired echo.
    same_delay = (
        reference.delay_gain > 0
        and existing.delay_gain > 0
        and abs(reference.delay_seconds - existing.delay_seconds)
        <= max(0.012, 0.08 * reference.delay_seconds)
    )
    existing_echo_gain = existing.delay_gain if same_delay else 0.0
    return SpaceProfile(
        delay_seconds=reference.delay_seconds,
        delay_gain=float(np.clip(reference.delay_gain - existing_echo_gain, 0, 0.35)),
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
        high = min(6000.0, rate * 0.45)
        low = min(180.0, high * 0.5)
        band = butter(2, [low, high], btype="bandpass", fs=rate, output="sos")
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
    """Measure loudness continuously and echo evidence in overlapping windows.

    Overlap avoids losing a repeat whenever its onset crosses a window edge.
    Windows are spread across the full reference, not just its beginning.
    """
    levels: list[float] = []
    cepstra: list[np.ndarray] = []
    energies: list[float] = []
    with sf.SoundFile(path) as source:
        rate = source.samplerate
        block = rate * 2
        step = max(1, round(rate * 0.02))
        # Preserve the original continuous loudness measurement.
        for samples in source.blocks(blocksize=block, always_2d=True):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            samples = samples[:, :2]
            usable = len(samples) // step * step
            if usable:
                power = np.mean(
                    samples[:usable].reshape(-1, step, samples.shape[1]) ** 2,
                    axis=(1, 2),
                )
                levels.extend(10 * np.log10(np.maximum(power, 1e-12)))
        if source.frames < block:
            return np.asarray(levels), np.empty((0, 8193))
        # One-second hops give independent placements of the same vocal phrase
        # inside the two-second analysis window. Limit cost on long songs.
        positions = np.arange(0, source.frames - block + 1, rate, dtype=np.int64)
        if len(positions) > 128:
            positions = positions[np.linspace(0, len(positions) - 1, 128).astype(int)]
        for position in positions:
            _check_cancel(cancel)
            source.seek(int(position))
            samples = source.read(block, dtype="float32", always_2d=True)[:, :2]
            if len(samples) != block:
                continue
            energy = float(np.mean(samples.astype(np.float64) ** 2))
            energies.append(energy)
            cepstra.append(_cepstrum(samples, rate))
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
