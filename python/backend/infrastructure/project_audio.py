"""Compact generated playback stems with verified gapless audio and waveform metadata."""

from __future__ import annotations

import os
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.infrastructure.lossless_audio import compress_audio, write_lossless_peaks
from backend.infrastructure.process_runner import ProcessRunner

_MP3_RATE = 320_000
_MPEG1_SAMPLE_RATES = frozenset({32000, 44100, 48000})


class CompactAudioLayoutError(ValueError):
    """An encoder/decoder pair did not preserve the exact source timeline or layout."""


def compact_stems(instrumental: Path, vocal: Path, workspace: Path) -> tuple[Path, Path]:
    """Two bounded encoders replace the former sequential FLAC/hash passes."""
    cancel = threading.Event()
    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="project-audio") as pool:
        backing = pool.submit(
            compact_audio,
            instrumental,
            workspace / "instrumental.mp3",
            ProcessRunner(),
            cancel,
            peaks=True,
        )
        reference = pool.submit(
            compact_audio,
            vocal,
            workspace / "reference-vocal.mp3",
            ProcessRunner(),
            cancel,
            peaks=False,
        )
        try:
            return backing.result(), reference.result()
        finally:
            cancel.set()


def copy_audio(source: Path, target: Path) -> None:
    """Share immutable input when possible; never modify the original through the link."""
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def compact_audio(
    source: Path,
    target: Path,
    runner: ProcessRunner,
    cancel: threading.Event,
    *,
    peaks: bool,
) -> Path:
    if cancel.is_set():
        raise InterruptedError("Project audio encoding was cancelled")
    info = sf.info(source)
    if info.frames <= 0:
        raise ValueError("Project audio has no samples")
    target.parent.mkdir(parents=True, exist_ok=True)
    already_compact = info.format == "MP3"
    if not already_compact and (
        info.samplerate not in _MPEG1_SAMPLE_RATES
        or info.channels not in {1, 2}
        or info.subtype not in {"PCM_16", "PCM_24"}
    ):
        # Never downsample or downmix an unusual existing project to fit the encoder.
        local = target.with_suffix(source.suffix.lower())
        copy_audio(source, local)
        return compress_audio(local, runner, cancel)
    required_bytes = int(info.duration * _MP3_RATE / 8) + 1024**2
    if shutil.disk_usage(target.parent).free < required_bytes:
        raise OSError("Insufficient space for verified compact audio")
    return _publish_compact(source, target, runner, cancel, peaks=peaks)


def _publish_compact(
    source: Path, target: Path, runner: ProcessRunner, cancel: threading.Event, *, peaks: bool
) -> Path:
    temporary = target.with_name(target.stem + ".encoding.mp3")
    temporary_peaks = Path(str(temporary) + ".peaks.json")
    try:
        info = sf.info(source)
        if info.format == "MP3":
            # Remote publication and melody-only regeneration must not add another lossy pass.
            copy_audio(source, temporary)
        else:
            _encode(source, temporary, runner, cancel, info.duration)
        _verify_encoded(source, temporary, cancel, peaks=peaks)
        if cancel.is_set():
            raise InterruptedError("Project audio encoding was cancelled")
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        if peaks:
            os.replace(temporary_peaks, Path(str(target) + ".peaks.json"))
        return target
    finally:
        temporary.unlink(missing_ok=True)
        temporary_peaks.unlink(missing_ok=True)


def _verify_encoded(source: Path, encoded: Path, cancel: threading.Event, *, peaks: bool) -> None:
    info, actual = sf.info(source), sf.info(encoded)
    if (actual.frames, actual.samplerate, actual.channels) != (
        info.frames,
        info.samplerate,
        info.channels,
    ):
        raise CompactAudioLayoutError("Compact audio duration or layout changed")
    if peaks:
        # The peaks pass also reads every sample and verifies finite, complete audio.
        write_lossless_peaks(encoded, cancel)
    else:
        _verify_samples(encoded, cancel)


def _verify_samples(path: Path, cancel: threading.Event) -> None:
    frames = 0
    with sf.SoundFile(path) as audio:
        for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
            if cancel.is_set():
                raise InterruptedError("Project audio encoding was cancelled")
            if not np.isfinite(block).all():
                raise ValueError("Compact audio contains invalid samples")
            frames += len(block)
        if frames != audio.frames:
            raise ValueError("Compact audio is incomplete")


def _encode(
    source: Path,
    target: Path,
    runner: ProcessRunner,
    cancel: threading.Event,
    duration: float,
) -> None:
    result = runner.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            *_encoder_options(),
            str(target),
        ],
        timeout_seconds=max(120, duration * 20),
        cancel=cancel,
        cpu_fraction=0.1 if os.name == "nt" else None,
    )
    if result.exit_code:
        raise ValueError("Project audio encoding failed")


def _encoder_options() -> list[str]:
    return [
        "-map_metadata",
        "-1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        str(_MP3_RATE),
        "-write_xing",
        "1",
        "-threads",
        "1",
    ]
