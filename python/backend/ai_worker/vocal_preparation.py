from __future__ import annotations

import numpy as np
import librosa
from pathlib import Path
from contextlib import redirect_stdout
import hashlib
import sys
import time
from types import MappingProxyType
import torch
from bs_roformer import MelBandRoformer
from demucs.apply import apply_model
from faster_whisper.vad import get_vad_model
import soundfile as sf
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
from scipy.signal import istft, stft

from backend.serialization import JsonValue
from backend.ai.catalog import BREATH_MODEL, REVERBERATION_MODEL, VOCAL_PREPARATION_MODEL
from backend.ai_worker.audio_io import read_mono, write_wav
from backend.ai_worker.breath import attenuate_breath_events, detect_breath_events
from backend.ai_worker.paths import model_file
from backend.ai_worker.spatial import suppress_reverberation
from backend.ai_worker.timing import _protected_frames

VERSION = "adaptive-bleed-4"
PARAMETERS: MappingProxyType[str, JsonValue] = MappingProxyType(
    {
        "fftSize": 4096,
        "hopSize": 512,
        "vocalPowerRatio": 0.1,
        "otherPowerRatio": 0.5,
        "minimumGain": 0.2,
        "periodicityProtection": 0.9,
        "supportedPeriodicityProtection": 0.5,
        "retainedVocalPowerProtection": 0.5,
        "speechProtection": 0.3,
        "protectionSeconds": 0.3,
        "overlapPeriodicity": 0.7,
        "overlapVocalPowerRatio": 0.5,
        "overlapRetainedVoice": 0.6,
        "overlapCoherence": 0.9,
        "overlapMinimumGain": 0.5,
        "overlapGain": "bounded-normalized-power-ratio",
        "harmonicContrast": 6,
        "harmonicProtectionBins": 9,
        "overlapLowFrequencyProtectionHz": 1100,
        "overlapMinimumBinPowerFraction": 0.000001,
        "overlapProfileSeconds": 0.25,
        "overlapProfileQuantile": 0.75,
        "overlapProfilePowerFraction": 0.25,
        "overlapProfile": "raw-to-independent-other-power",
    }
)


_MODEL_PARAMETERS = MappingProxyType(
    {
        "dim": 384,
        "depth": 6,
        "stereo": True,
        "num_stems": 1,
        "time_transformer_depth": 1,
        "freq_transformer_depth": 1,
        "num_bands": 60,
        "dim_head": 64,
        "heads": 8,
        "attn_dropout": 0,
        "ff_dropout": 0,
        "flash_attn": True,
        "sample_rate": 44100,
        "stft_n_fft": 2048,
        "stft_hop_length": 441,
        "stft_win_length": 2048,
        "stft_normalized": False,
        "mask_estimator_depth": 3,
    }
)

_INFERENCE_PARAMETERS: MappingProxyType[str, JsonValue] = MappingProxyType(
    {"precision": "float32", "window": "hann", "segment": 8, "overlap": 0.25, "shifts": 0}
)


class _VocalEstimator(MelBandRoformer):
    samplerate = 44100
    segment = 8
    sources = ("vocals",)

    def valid_length(self, length: int) -> int:
        return max(5, (length + 440) // 441) * 441

    def forward(self, audio: torch.Tensor) -> torch.Tensor:
        prediction: torch.Tensor = super().forward(audio)
        return prediction[:, None]


def estimate_voice(
    mix: np.ndarray, weights: Path, target: str, *, separate_channels: bool = False
) -> np.ndarray:
    """Verified Hann frontend, optionally retaining each channel in its own model input."""
    with redirect_stdout(sys.stderr):
        model = _VocalEstimator(**_MODEL_PARAMETERS).eval().to(target)
    model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True), strict=True)
    # This checkpoint uses Hann, whereas BS-RoFormer 0.3.1 defaults to rectangular.
    model.stft_kwargs["window"] = torch.hann_window(2048, device=target)
    batch = np.repeat(mix[:, None], 2, axis=1) if separate_channels else mix[None]
    with torch.inference_mode():
        estimate = (
            apply_model(
                model,
                torch.from_numpy(batch),
                device=target,
                shifts=0,
                overlap=0.5 if separate_channels else 0.25,
                split=True,
                progress=False,
            )
            .cpu()
            .numpy()
        )
    return estimate[:, 0, 0] if separate_channels else estimate[0, 0]


def prepare_vocal(source: Path, raw_path: Path, target: str) -> tuple[Path, dict[str, JsonValue]]:
    started = time.perf_counter()
    mix, rate = sf.read(source, dtype="float32", always_2d=True)
    raw, raw_rate = sf.read(raw_path, dtype="float32", always_2d=True)
    if rate != 44100 or rate != raw_rate or mix.shape != raw.shape or mix.shape[1] != 2:
        raise ValueError("Vocal preparation requires the aligned 44.1 kHz stereo mix and raw stem")
    estimate = estimate_voice(mix.T.copy(), model_file(VOCAL_PREPARATION_MODEL), target)
    estimated = time.perf_counter() - started
    mono = read_mono(raw_path, 16000)
    speech = get_vad_model()(np.pad(mono, (0, -len(mono) % 512))).reshape(-1)
    cleaned, report = suppress_instrumental_bleed(raw.T, estimate, mix.T - estimate, rate, speech)
    bleed_finished = time.perf_counter()
    cleaned, report["reverberation"] = _clean_reverberation(cleaned, rate, target)
    spatial_finished = time.perf_counter()
    cleaned, report["breath"] = _clean_breaths(raw.T, cleaned, estimate, rate, target)
    breath_finished = time.perf_counter()
    path = raw_path.with_name("prepared-vocals.wav")
    write_wav(path, cleaned, rate)
    report.update(
        {
            "algorithmVersion": "adaptive-vocal-6",
            "decision": "attenuated" if not np.array_equal(cleaned, raw.T) else "unchanged",
            "regions": _changed_regions(raw.T, cleaned, rate),
            "sha256": _audio_hashes(source, raw_path, path),
            "model": VOCAL_PREPARATION_MODEL.model_id,
            "modelSha256": VOCAL_PREPARATION_MODEL.checksum,
            "runtime": "BS-RoFormer==0.3.1",
            "inference": _INFERENCE_PARAMETERS.copy(),
            "seconds": {
                "estimate": estimated,
                "bleedAndVad": bleed_finished - started - estimated,
                "reverberation": spatial_finished - bleed_finished,
                "breath": breath_finished - spatial_finished,
                "total": time.perf_counter() - started,
            },
        }
    )
    return path, report


def _audio_hashes(source: Path, raw: Path, prepared: Path) -> dict[str, JsonValue]:
    hashes: dict[str, JsonValue] = {}
    for name, path in (("originalMix", source), ("rawVocal", raw), ("preparedVocal", prepared)):
        with path.open("rb") as stream:
            hashes[name] = hashlib.file_digest(stream, "sha256").hexdigest()
    return hashes


def _clean_reverberation(
    raw: np.ndarray, rate: int, target: str
) -> tuple[np.ndarray, dict[str, JsonValue]]:
    if raw.shape[1] < rate:
        return raw, {"decision": "unchanged:insufficient-context"}
    started = time.perf_counter()
    dry = estimate_voice(raw, model_file(REVERBERATION_MODEL), target, separate_channels=True)
    cleaned, report = suppress_reverberation(raw, dry, rate)
    report.update(
        {
            "model": REVERBERATION_MODEL.model_id,
            "modelSha256": REVERBERATION_MODEL.checksum,
            "modelCard": "https://huggingface.co/anvuew/dereverb_mel_band_roformer",
            "license": "GPL-3.0",
            "sampleRate": rate,
            "samples": raw.shape[1],
            "inputPcmSha256": [hashlib.sha256(channel.tobytes()).hexdigest() for channel in raw],
            "candidatePcmSha256": [
                hashlib.sha256(channel.tobytes()).hexdigest() for channel in dry
            ],
            "inference": {**_INFERENCE_PARAMETERS, "overlap": 0.5, "channels": "independent-batch"},
            "seconds": time.perf_counter() - started,
        }
    )
    return cleaned, report


def _clean_breaths(
    raw: np.ndarray, cleaned: np.ndarray, estimate: np.ndarray, rate: int, target: str
) -> tuple[np.ndarray, dict[str, JsonValue]]:
    if raw.shape[1] < rate:
        return cleaned, {"decision": "unchanged:insufficient-context"}
    probabilities, inputs = detect_breath_events(cleaned, rate, model_file(BREATH_MODEL), target)
    protected = np.zeros_like(probabilities)
    for channel, (samples, voice) in enumerate(zip(raw, estimate)):
        _, times, spectrum = stft(samples, rate, nperseg=4096, noverlap=3584)
        voice_power = abs(stft(voice, rate, nperseg=4096, noverlap=3584)[2]) ** 2
        mono = librosa.resample(samples, orig_sr=rate, target_sr=16000)
        speech = get_vad_model()(np.pad(mono, (0, -len(mono) % 512))).reshape(-1)
        guard, _ = _protected_frames(abs(spectrum) ** 2, times, rate, speech, voice_power)
        protected[channel] = np.interp(np.arange(probabilities.shape[1]) / 100, times, guard) > 0
    result, report = attenuate_breath_events(cleaned, probabilities, protected, rate)
    report.update(
        {
            "model": BREATH_MODEL.model_id,
            "modelSha256": BREATH_MODEL.checksum,
            "detectionInputs": inputs,
            "inputRole": "after-instrumental-bleed-suppression",
        }
    )
    return result, report


def suppress_instrumental_bleed(
    raw: np.ndarray,
    estimated_voice: np.ndarray,
    estimated_other: np.ndarray,
    rate: int,
    speech: np.ndarray | None = None,
) -> tuple[np.ndarray, dict[str, JsonValue]]:
    """Attenuate corroborated bleed while protecting voice bands and uncertain frames.

    All inputs are channel-first and time-aligned. The two estimates must come from
    the original mix, independently of the raw separator. Neither absent ASR/CTC
    nor absent VAD alone authorizes attenuation. No waveform from the estimate is
    substituted for the raw voice, and no stereo-to-mono fold is performed here.
    """
    if raw.ndim != 2 or any(
        item.shape != raw.shape or not np.isfinite(item).all()
        for item in (raw, estimated_voice, estimated_other)
    ):
        raise ValueError("Vocal preparation requires finite, aligned channel-first audio")
    if rate < 8000 or (speech is not None and (speech.ndim != 1 or not np.isfinite(speech).all())):
        raise ValueError("Invalid vocal preparation sample rate or speech evidence")
    result = raw.copy()
    report: dict[str, JsonValue] = {
        "algorithmVersion": VERSION,
        "parameters": PARAMETERS.copy(),
        "channels": [],
    }
    if raw.shape[1] < 4096:
        report["decision"] = "unchanged:insufficient-context"
        return result, report
    channels: list[JsonValue] = []
    for channel in range(len(raw)):
        result[channel], details = _attenuate_channel(
            raw[channel], estimated_voice[channel], estimated_other[channel], rate, speech
        )
        channels.append(details)
    report["channels"] = channels
    report["decision"] = "attenuated" if not np.array_equal(result, raw) else "unchanged"
    report["regions"] = _changed_regions(raw, result, rate)
    return result, report


def _attenuate_channel(
    raw: np.ndarray, voice: np.ndarray, other: np.ndarray, rate: int, speech: np.ndarray | None
) -> tuple[np.ndarray, dict[str, JsonValue]]:
    spectra = [stft(item, rate, nperseg=4096, noverlap=3584) for item in (raw, voice, other)]
    times, spectrum = spectra[0][1:]
    power, voice_power, other_power = [abs(item[2]) ** 2 for item in spectra]
    protected, voiced = _protected_frames(power, times, rate, speech, voice_power)
    ratio = uniform_filter1d(voice_power, 7, axis=1) / np.maximum(
        uniform_filter1d(power, 7, axis=1), 1e-20
    )
    corroborated = (ratio < 0.1) & (other_power > power * 0.5)
    context = ~protected & (power.sum(axis=0) > power.sum(axis=0).max() * 1e-8)
    overlap = np.zeros_like(power, dtype=bool)
    if context.sum() * 512 / rate >= 0.25 and voiced.any():
        overlap = _overlap_bins(
            spectrum,
            spectra[2][2],
            power,
            other_power,
            corroborated,
            context,
            voiced,
            spectra[0][0],
        )
    gain = _bleed_gain(power, other_power, ratio, protected, overlap)
    # Reconstruct only the removed component, leaving unaffected samples exact.
    _, difference = istft(spectrum * (gain - 1), rate, nperseg=4096, noverlap=3584)
    result = raw + difference[: len(raw)].astype(raw.dtype)
    rollback = bool(np.max(abs(result)) > 1)
    return (raw.copy() if rollback else result), {
        "protectedFrameFraction": float(np.mean(protected)),
        "attenuatedBinFraction": float(np.mean(gain < 0.999)),
        "overlapAttenuatedBinFraction": float(np.mean((gain < 0.999) & protected[None, :])),
        "instrumentalProfileSeconds": float(context.sum() * 512 / rate),
        "rollback": "pcm-overflow" if rollback else None,
    }


def _bleed_gain(
    power: np.ndarray,
    other_power: np.ndarray,
    ratio: np.ndarray,
    protected: np.ndarray,
    overlap: np.ndarray,
) -> np.ndarray:
    allowed = ~protected[None, :] | overlap
    limit = np.where(protected[None, :], 0.5, 0.1)
    identified = (ratio < limit) & (other_power > power * 0.5) & allowed
    # Approach unity at the evidence limit; suppress at most 6 dB during protected voice.
    attenuation = np.where(
        protected[None, :], np.maximum(0.5, ratio / limit), 0.2 + np.minimum(1, ratio / limit) * 0.8
    )
    gain: np.ndarray = np.where(identified, attenuation, 1)
    gain = maximum_filter1d(gain, 3, axis=0)
    gain = uniform_filter1d(gain, 7, axis=1)
    gain[~allowed] = 1
    return gain


def _overlap_bins(
    spectrum: np.ndarray,
    other_spectrum: np.ndarray,
    power: np.ndarray,
    other_power: np.ndarray,
    corroborated: np.ndarray,
    context: np.ndarray,
    voiced: np.ndarray,
    frequencies: np.ndarray,
) -> np.ndarray:
    # Learn only from independently corroborated bleed outside protected voice.
    transfer = np.where(
        corroborated[:, context], power[:, context] / np.maximum(other_power[:, context], 1e-20), 0
    )
    profile = np.quantile(transfer, 0.75, axis=1)
    columns = np.flatnonzero(voiced)
    local = power[:, columns]
    cross = uniform_filter1d(spectrum * other_spectrum.conj(), 7, axis=1)
    coherence = abs(cross) ** 2 / np.maximum(
        uniform_filter1d(power, 7, axis=1) * uniform_filter1d(other_power, 7, axis=1), 1e-20
    )
    # Protect every tonal peak, including backing voices and sparse harmonics;
    # no strongest-pitch assumption may discard a second voice or a weak fundamental.
    tonal = local > median_filter(local, size=(31, 1)) * 6
    voice_bands = maximum_filter1d(tonal, 9, axis=0) | (frequencies[:, None] <= 1100)
    overlap = np.zeros_like(power, dtype=bool)
    overlap[:, columns] = (
        ~voice_bands
        & (coherence[:, columns] > 0.9)
        & (local > local.sum(axis=0) * 1e-6)
        & (profile[:, None] * other_power[:, columns] > local * 0.25)
    )
    return overlap


def _changed_regions(raw: np.ndarray, result: np.ndarray, rate: int) -> list[JsonValue]:
    regions: list[JsonValue] = []
    for start in range(0, raw.shape[1], rate):
        end = min(start + rate, raw.shape[1])
        before, after = raw[:, start:end], result[:, start:end]
        removed = float(np.mean((before - after) ** 2))
        power = float(np.mean(before**2))
        if removed <= max(1e-20, power * 1e-10):
            continue
        regions.append(
            {
                "start": start / rate,
                "end": end / rate,
                "inputRms": power**0.5,
                "removedRms": removed**0.5,
                "changeDb": float(
                    10 * np.log10(max(float(np.mean(after**2)), 1e-20) / max(power, 1e-20))
                ),
            }
        )
    return regions
