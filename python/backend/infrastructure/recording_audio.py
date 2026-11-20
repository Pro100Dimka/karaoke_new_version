"""Compact listening copies without sacrificing the only remastering source."""

from __future__ import annotations

import math
import os
import threading
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import soundfile as sf

from backend.domain_errors import DomainError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.ffmpeg_audio import loudnorm_filter, parse_loudness
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.lossless_audio import compress_audio
from backend.infrastructure.process_runner import ProcessRunner
from backend.infrastructure.project_audio import CompactAudioLayoutError, compact_audio
from backend.recordings.studio_audio import recording_stems
from backend.serialization import dumps


def compact_recording(
    source: Path,
    runner: ProcessRunner,
    cancel: threading.Event,
    *,
    master: bool = False,
) -> Path:
    if cancel.is_set():
        raise InterruptedError("Recording archival was cancelled")
    info = sf.info(source)
    eligible = info.samplerate in {32000, 44100, 48000} and info.channels in {1, 2}
    if info.format != "MP3" and (
        not eligible
        or info.subtype not in {"PCM_16", "PCM_24"}
        or (not master and not _retained_sources(source, cancel))
    ):
        return _lossless(source, runner, cancel, "PreserveRemasteringSourceOrLayout")
    with TemporaryDirectory(prefix=".recording-archive-", dir=source.parent) as directory:
        try:
            candidate = compact_audio(
                source, Path(directory) / "recording.mp3", runner, cancel, peaks=True
            )
        except CompactAudioLayoutError:
            if info.format == "MP3":
                raise
            return _lossless(source, runner, cancel, "PreserveExactTimeline")
        levels = _measure(candidate, runner, cancel)
        peak = levels.get("input_tp", float("nan"))
        if not math.isfinite(peak) or peak > (-1.0 if master else -0.1):
            if info.format == "MP3":
                raise ValueError("Existing MP3 does not meet the recording peak ceiling")
            return _lossless(source, runner, cancel, "RetainVerifiedPeakHeadroom")
        if cancel.is_set():
            raise InterruptedError("Recording archival was cancelled")
        target = source.with_suffix(".mp3")
        _publish_candidate(candidate, target, levels, reused=info.format == "MP3")
        return target


def _retained_sources(source: Path, cancel: threading.Event) -> bool:
    try:
        stems = recording_stems(source, prefer_dry=True)
        return stems is not None and all(_lossless_source(stem, cancel) for stem in stems)
    except InterruptedError:
        raise
    except (DomainError, OSError, RuntimeError, ValueError):
        # The original mix remains lossless when retained sources cannot be trusted.
        return False


def _lossless_source(path: Path, cancel: threading.Event) -> bool:
    if path.resolve() != path:
        return False
    identity = _identity(path)
    with sf.SoundFile(path) as audio:
        if audio.format not in {"WAV", "WAVEX", "RF64", "FLAC"}:
            return False
        if audio.subtype not in {"PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"}:
            return False
        frames = 0
        for block in audio.blocks(blocksize=65536, dtype="float32", always_2d=True):
            if cancel.is_set():
                raise InterruptedError("Recording archival was cancelled")
            if not np.isfinite(block).all():
                return False
            frames += len(block)
        complete = frames == audio.frames and frames > 0
    return complete and identity == _identity(path)


def _identity(path: Path) -> tuple[int, int, int, int]:
    stat = path.stat()
    return stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _lossless(source: Path, runner: ProcessRunner, cancel: threading.Event, reason: str) -> Path:
    target = compress_audio(source, runner, cancel)
    _report(target, {"reason": reason, "sampleExact": True})
    return target


def _measure(path: Path, runner: ProcessRunner, cancel: threading.Event) -> dict[str, float]:
    result = runner.run(
        [
            "ffmpeg",
            "-v",
            "info",
            "-nostdin",
            "-nostats",
            "-threads",
            "1",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            loudnorm_filter(lra=11),
            "-f",
            "null",
            "-",
        ],
        timeout_seconds=max(120, sf.info(path).duration * 20),
        cancel=cancel,
        cpu_fraction=0.1 if os.name == "nt" else None,
    )
    levels = parse_loudness(result.stderr)
    if result.exit_code or levels is None:
        raise ValueError("Compressed recording peak verification failed")
    return levels


def _publish_candidate(
    candidate: Path, target: Path, levels: dict[str, float], *, reused: bool
) -> None:
    if target.resolve() != target:
        raise ValueError("Archived recording cannot be an alias")
    os.replace(candidate, target)
    os.replace(Path(str(candidate) + ".peaks.json"), Path(str(target) + ".peaks.json"))
    loudness = levels.get("input_i", float("nan"))
    _report(
        target,
        {
            "sampleExact": False,
            **({"reused": True} if reused else {"bitrate": 320_000}),
            "truePeakDbtp": levels["input_tp"],
            "integratedLufs": loudness if math.isfinite(loudness) else None,
        },
    )


def _report(path: Path, measurements: dict[str, object]) -> None:
    info = sf.info(path)
    atomic_write_text(
        Path(str(path) + ".archive.json"),
        dumps(
            {
                "version": 1,
                "file": path.name,
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
                "format": info.format,
                "frames": info.frames,
                "sampleRate": info.samplerate,
                "channels": info.channels,
                **measurements,
            }
        ),
    )
