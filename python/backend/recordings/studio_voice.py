from pathlib import Path
import threading
from typing import Protocol
import numpy as np
from numpy.typing import NDArray
import soundfile as sf
from scipy.ndimage import gaussian_filter1d
from backend.recordings.studio_audio import (
    MasterRenderer,
    _temporary_wave,
    _check_cancel,
    _profile,
    _write_gain_envelope,
)
from backend.recordings.studio_calibration import GainPlan
from backend.recordings.studio_sibilance import apply_sibilance_control
from backend.recordings.studio_spectrum import SpectrumPlan, measure_mix_spectrum
from backend.recordings.studio_space import apply_reference_space
from backend.recordings.studio_layers import LayerRender, apply_reference_layers


class VoiceFinishing(LayerRender, Protocol):
    user_vocal: Path
    reference_vocal: Path
    backing: Path
    times: NDArray[np.floating]
    source_times: NDArray[np.floating]


def finish_voice(render: VoiceFinishing) -> None:
    direct = render.balanced
    target = render.work / "spatial-voice.wav"
    effects = apply_reference_space(
        render.renderer,
        render.reference_vocal,
        render.user_vocal,
        render.balanced,
        target,
        render.cancel,
        full_reference=render.space_reference,
        recorded_is_dry=render.process_voice,
    )
    render.processing["referenceEffects"] = effects
    render.processing["space"] = effects["status"]
    render.processing["effectsApplied"] = effects["status"] == "matched"
    if target.is_file():
        render.balanced = target
    render.balanced, render.processing["mixIntegration"] = integrate_voice(
        render.renderer,
        render.balanced,
        render.backing,
        render.reference_vocal,
        render.work / "integrated-voice.wav",
        render.cancel,
        reference_timing=(render.times, render.source_times) if render.timing_known else None,
        placement_calibrated=True,
    )
    render.processing["voiceOutputGainDb"] = 0.0
    apply_reference_layers(render, direct)


def prepare_voice(
    renderer: MasterRenderer,
    source: Path,
    backing: Path,
    target: Path,
    cancel: threading.Event,
    *,
    frames: int,
    rate: int,
    channels: int,
) -> tuple[Path, dict[str, object]]:
    """Prepare the dry path before measuring pitch, tone and vocal placement."""
    renderer._mix(
        source,
        backing,
        f"[0:a]highpass=f=60,apad,atrim=end_sample={frames}[out]",
        ["-ar", str(rate), "-ac", str(channels), "-c:a", "pcm_f32le", str(target)],
        cancel,
    )
    return apply_sibilance_control(target, target.with_stem(target.stem + "-deessed"), cancel)


def integrate_voice(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    reference: Path,
    target: Path,
    cancel: threading.Event,
    *,
    reference_timing: tuple[np.ndarray, np.ndarray] | None,
    placement_calibrated: bool = False,
) -> tuple[Path, dict[str, object]]:
    """Place the processed voice locally without changing the backing or adding effects."""
    times, cuts = _body_correction(voice, reference, reference_timing, cancel)
    toned = _render_body_correction(renderer, voice, backing, target, times, cuts, cancel)
    reduction = (
        np.zeros_like(cuts)
        if placement_calibrated
        else _placement_reduction(toned, backing, cancel)
    )
    report: dict[str, object] = {
        "method": "local-tone-and-placement",
        "stepSeconds": 0.1,
        "bodyCutDb": cuts.round(4).tolist(),
        "placementTrimDb": reduction.round(4).tolist(),
        "placementCalibrated": placement_calibrated,
    }
    if np.max(reduction) > 0:
        _write_gain_envelope(toned, target, times, -reduction, cancel)
        toned = target
    _check_cancel(cancel)
    return toned, report


def _render_body_correction(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    target: Path,
    times: np.ndarray,
    cuts: np.ndarray,
    cancel: threading.Event,
) -> Path:
    if np.max(cuts) <= 0:
        return voice
    filtered = _equalize(
        renderer,
        voice,
        backing,
        target.with_stem(target.stem + "-body"),
        [{"frequencyHz": 350.0, "gainDb": -4.5}],
        cancel,
    )
    toned = target.with_stem(target.stem + "-tone")
    _blend_voice(voice, filtered, toned, times, cuts / 4.5, cancel)
    return toned


def _placement_reduction(voice: Path, backing: Path, cancel: threading.Event) -> np.ndarray:
    vocal, music = [10 ** (_profile(path, cancel) / 10) for path in (voice, backing)]
    contrast = 10 * np.log10(
        gaussian_filter1d(vocal, 4) / np.maximum(gaussian_filter1d(music, 4), 1e-12)
    )
    audible = music > max(float(np.percentile(music, 80)) * 0.01, 1e-10)
    return np.asarray(gaussian_filter1d(np.clip(contrast - 1.5, 0, 2.5) * audible, 4))


def _body_correction(
    voice: Path,
    reference: Path,
    timing: tuple[np.ndarray, np.ndarray] | None,
    cancel: threading.Event,
) -> tuple[np.ndarray, np.ndarray]:
    mid = _profile(voice, cancel, voice_band=True, band_hz=(600, 3500))
    times = (np.arange(len(mid)) + 0.5) * 0.1
    if timing is None:
        return times, np.zeros_like(mid)
    body = _profile(voice, cancel, voice_band=True, band_hz=(150, 600))
    source_times = np.interp(times, *timing)
    guide = []
    for band in [(150, 600), (600, 3500)]:
        levels = _profile(reference, cancel, voice_band=True, band_hz=band)
        axis = (np.arange(len(levels)) + 0.5) * 0.1
        guide.append(np.interp(source_times, axis, levels, left=-120, right=-120))
    ref_body, ref_mid = guide
    active = (mid > max(float(np.percentile(mid, 80)) - 17, -80)) & (
        ref_mid > max(float(np.percentile(ref_mid, 80)) - 17, -80)
    )
    coverage = np.maximum(gaussian_filter1d(active.astype(float), 10), 1e-9)
    # Relative band proportions avoid copying the original singer's absolute volume.
    smooth = [
        10 * np.log10(np.maximum(gaussian_filter1d(10 ** (x / 10) * active, 10) / coverage, 1e-12))
        for x in (body, mid, ref_body, ref_mid)
    ]
    excess = smooth[0] - smooth[1] - smooth[2] + smooth[3]
    cuts = gaussian_filter1d(np.clip(excess - 2, 0, 4.5) * active, 3)
    return times, np.asarray(cuts)


def shape_voice(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    target: Path,
    cancel: threading.Event,
    *,
    plan: SpectrumPlan | None = None,
    automation: GainPlan | None = None,
) -> tuple[Path, SpectrumPlan]:
    if plan is None:
        plan = measure_mix_spectrum(voice, backing, cancel)
    if not plan["bands"]:
        return voice, plan
    clarity = plan.get("clarityBands", [])
    if automation is None or automation.presence is None or not clarity:
        return _equalize(renderer, voice, backing, target, plan["bands"], cancel), plan
    tone = _equalize(
        renderer,
        voice,
        backing,
        target.with_stem(target.stem + "-tone"),
        plan["bands"][: -len(clarity)],
        cancel,
    )
    colored = _equalize(
        renderer, tone, backing, target.with_stem(target.stem + "-clarity"), clarity, cancel
    )
    weights = np.clip(automation.presence / 2, 0, 1)
    _blend_voice(tone, colored, target, automation.times, weights, cancel)
    plan["clarityAutomation"] = {"stepSeconds": 0.5, "weight": weights[::25].round(3).tolist()}
    return target, plan


def _equalize(
    renderer: MasterRenderer,
    voice: Path,
    backing: Path,
    target: Path,
    bands: list[dict[str, float]],
    cancel: threading.Event,
) -> Path:
    if not bands:
        return voice
    filters = [f"equalizer=f={b['frequencyHz']:.6f}:t=q:w=0.7:g={b['gainDb']:.6f}" for b in bands]
    renderer._mix(
        voice,
        backing,
        "[0:a]" + ",".join(filters) + "[out]",
        ["-c:a", "pcm_f32le", str(target)],
        cancel,
    )
    return target


def _blend_voice(
    tone: Path,
    colored: Path,
    target: Path,
    times: np.ndarray,
    weights: np.ndarray,
    cancel: threading.Event,
) -> None:
    with (
        sf.SoundFile(tone) as dry,
        sf.SoundFile(colored) as equalized,
        _temporary_wave(
            target,
            samplerate=dry.samplerate,
            channels=dry.channels,
        ) as output,
    ):
        for samples in dry.blocks(blocksize=65536, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            position = (dry.tell() - len(samples) + np.arange(len(samples))) / dry.samplerate
            wet = equalized.read(len(samples), dtype="float32", always_2d=True)
            weight = np.interp(position, times, weights)[:, None]
            output.write(samples + (wet - samples) * weight)
