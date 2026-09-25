from __future__ import annotations

import math
from pathlib import Path

import torch
from demucs.apply import apply_model
from demucs.audio import AudioFile
from demucs.states import load_model

from backend.ai.catalog import SEPARATION_MODEL
from backend.ai_worker.audio_io import write_wav
from backend.ai_worker.paths import model_file
from backend.ai_worker.runtime import cpu_threads, device

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


def separate(audio: Path, output: Path) -> dict[str, str]:
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
    return {"instrumental": str(instrumental_path), "referenceVocal": str(vocal_path)}
