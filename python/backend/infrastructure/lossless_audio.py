from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path

import soundfile as sf
import numpy as np

from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.hashing import sha256_file
from backend.serialization import dumps


def _run_audio(
    runner: ProcessRunner, arguments: list[str], cancel: threading.Event, duration: float
) -> bytes:
    result = runner.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", *arguments],
        timeout_seconds=max(120, duration * 20),
        cancel=cancel,
        cpu_fraction=0.1 if os.name == "nt" else None,
    )
    if result.exit_code:
        raise ValueError("Lossless audio conversion failed")
    return result.stdout


def audio_digest(
    path: Path, runner: ProcessRunner, cancel: threading.Event, duration: float, pcm: str
) -> bytes:
    return _run_audio(
        runner,
        ["-i", str(path), "-map", "0:a:0", "-c:a", pcm, "-f", "hash", "-hash", "sha256", "-"],
        cancel,
        duration,
    ).strip()


def compress_audio(source: Path, runner: ProcessRunner, cancel: threading.Event) -> Path:
    """Keep the source until its owner has atomically published the verified replacement."""
    info = sf.info(source)
    if source.suffix.lower() == ".flac":
        write_lossless_peaks(source, cancel)
        return source
    if info.subtype not in {"PCM_16", "PCM_24"} or source.suffix.lower() != ".wav":
        return source
    target = source.with_suffix(".flac")
    if target.resolve() != target:
        raise ValueError("Compressed audio cannot be an alias")
    if shutil.disk_usage(source.parent).free < source.stat().st_size + 32 * 1024**2:
        raise OSError("Insufficient space for a verified lossless copy")
    temporary = target.with_name(target.stem + ".compressing.flac")
    try:
        _encode_verified(source, temporary, runner, cancel, info.duration)
        encoded = sf.info(temporary)
        if (encoded.frames, encoded.samplerate, encoded.channels) != (
            info.frames,
            info.samplerate,
            info.channels,
        ):
            raise ValueError("Lossless audio duration or layout changed")
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        write_lossless_peaks(target, cancel)
        return target
    finally:
        temporary.unlink(missing_ok=True)


def write_lossless_peaks(path: Path, cancel: threading.Event) -> None:
    peaks = np.zeros(4096)
    frames = 0
    with sf.SoundFile(path) as audio:
        if audio.frames <= 0:
            raise ValueError("Audio has no samples")
        for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
            if cancel.is_set():
                raise InterruptedError("Audio compression was cancelled")
            if not np.isfinite(block).all():
                raise ValueError("Audio contains invalid samples")
            slots = np.arange(frames, frames + len(block)) * len(peaks) // audio.frames
            np.maximum.at(peaks, slots, np.abs(block).max(axis=1))
            frames += len(block)
        if frames != audio.frames:
            raise ValueError("Audio is incomplete")
    atomic_write_text(
        Path(str(path) + ".peaks.json"),
        dumps(
            {
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
                "peaks": np.round(peaks / (float(peaks.max()) or 1), 3).tolist(),
            }
        ),
    )


def _encode_verified(
    source: Path,
    temporary: Path,
    runner: ProcessRunner,
    cancel: threading.Event,
    duration: float,
) -> None:
    _run_audio(
        runner,
        [
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-c:a",
            "flac",
            "-compression_level",
            "1",
            "-threads",
            "1",
            str(temporary),
        ],
        cancel,
        duration,
    )
    expected = audio_digest(source, runner, cancel, duration, "pcm_s32le")
    if not expected.startswith(b"SHA256=") or expected != audio_digest(
        temporary, runner, cancel, duration, "pcm_s32le"
    ):
        raise ValueError("Lossless audio samples differ from the source")
