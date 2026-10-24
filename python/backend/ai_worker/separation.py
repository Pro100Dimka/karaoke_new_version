from __future__ import annotations

import math
from pathlib import Path
from collections.abc import Sequence

import numpy as np
import torch
from scipy.signal import butter, sosfilt, find_peaks
from demucs.apply import apply_model
from demucs.audio import AudioFile
from demucs.states import load_model

from backend.ai.catalog import SEPARATION_MODEL
from backend.ai_worker.audio_io import write_wav
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import cpu_threads, device
from backend.serialization import JsonValue

_OVERLAP = 0.25
_VOCALS = "vocals"
_EPSILON = 1e-8


def _parallelism(target: str, cpu_threads: int) -> tuple[int, int]:
    """Split the admitted CPU budget between independent Demucs chunks.

    The square-root split balances inter-chunk and intra-op parallelism without
    encoding a processor model or a machine-specific worker count.
    """
    threads = max(1, cpu_threads)
    if target != "cpu" or threads == 1:
        return 0, threads
    workers = math.isqrt(threads)
    return workers, max(1, threads // workers)


def separate(audio: Path, output: Path) -> dict[str, JsonValue]:
    model = load_model(str(model_file(SEPARATION_MODEL))).eval()
    wav = AudioFile(audio).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    reference = wav.mean(0)
    mean, deviation = reference.mean(), reference.std() + _EPSILON
    target = device()
    workers, threads_per_worker = _parallelism(target, cpu_threads())
    torch.set_num_threads(threads_per_worker)
    with torch.inference_mode():
        sources = apply_model(
            model,
            ((wav - mean) / deviation)[None],
            device=target,
            split=True,
            overlap=_OVERLAP,
            progress=False,
            num_workers=workers,
        )[0]
    sources = sources * deviation + mean
    vocals = sources[model.sources.index(_VOCALS)]
    instrumental = sources.sum(0) - vocals
    output.mkdir(parents=True, exist_ok=True)
    vocal_path, instrumental_path = output / "vocals.wav", output / "instrumental.wav"
    write_wav(vocal_path, vocals.cpu().numpy(), model.samplerate)
    write_wav(instrumental_path, instrumental.cpu().numpy(), model.samplerate)
    return {
        "instrumental": str(instrumental_path),
        "referenceVocal": str(vocal_path),
        "rhythm": _rhythm(sources, model.sources, model.samplerate),
    }


def _rhythm(sources: torch.Tensor, names: Sequence[str], rate: int) -> list[JsonValue]:
    """Reuse Demucs stems; melody/vocals and cymbal-only highs cannot drive lyrics."""
    hop = max(1, round(rate * 0.01))
    channels = []
    for name, band in [("bass", (35, 180)), ("drums", (35, 180)), ("drums", (180, 1500))]:
        samples = sources[names.index(name)].detach().cpu().numpy().mean(axis=0)
        filtered = sosfilt(butter(4, band, btype="bandpass", fs=rate, output="sos"), samples)
        energy = np.sqrt(
            np.mean(np.square(filtered[: len(filtered) // hop * hop].reshape(-1, hop)), axis=1)
        )
        full = np.sqrt(np.mean(np.square(samples[: len(energy) * hop].reshape(-1, hop)), axis=1))
        previous = np.maximum.reduce(
            [np.pad(energy, (lag, 0))[: len(energy)] for lag in range(1, 5)]
        )
        attacks = np.maximum(0, energy - previous * 1.12)
        # Do not amplify quiet separator bleed or filter startup into full-strength beats.
        scale = max(0.025, float(np.percentile(attacks, 99)))
        # A cymbal leaks into the body band, but its energy remains overwhelmingly above it.
        audible = (energy > 0.012) & ((energy >= full * 0.3) if name == "drums" else True)
        channels.append(np.where(audible, np.clip(attacks / scale, 0, 1), 0))
    envelope = np.max(channels, axis=0)
    peaks, _ = find_peaks(np.pad(envelope, (1, 1)), height=0.2, prominence=0.15, distance=12)
    return [
        [round((index - 1) * hop / rate, 3), round(float(envelope[index - 1]), 3)]
        for index in peaks
    ]
