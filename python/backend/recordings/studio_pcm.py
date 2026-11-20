"""Sample-preserving copies for lossless sources that require no timeline DSP."""

from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.analysis.domain import PlaybackAdjustment
from backend.recordings.studio_audio import _check_cancel, _temporary_wave


def lossless_pcm(info: sf._SoundFileInfo) -> bool:
    return info.format in {"WAV", "WAVEX", "RF64", "FLAC"} and info.subtype in {
        "FLOAT",
        "PCM_16",
        "PCM_24",
        "PCM_32",
    }


def copy_pcm(
    source: Path, target: Path, cancel: threading.Event, *, frames: int, channels: int
) -> None:
    _check_cancel(cancel)
    with (
        sf.SoundFile(source) as audio,
        _temporary_wave(target, samplerate=audio.samplerate, channels=channels) as output,
    ):
        remaining = frames
        while remaining:
            _check_cancel(cancel)
            count = min(65536, remaining)
            block = audio.read(count, dtype="float32", always_2d=True)[:, :channels]
            if len(block) != count:
                block = np.pad(block, ((0, count - len(block)), (0, 0)))
            output.write(block)
            remaining -= count


def copy_identity_timeline(
    source: Path,
    target: Path,
    cancel: threading.Event,
    points: tuple[PlaybackAdjustment, ...],
    frames: int,
    rate: int,
    channels: int,
) -> bool:
    info = sf.info(source)
    if len(points) != 1 or not lossless_pcm(info):
        return False
    # Extended WAVE and FLAC can carry speaker masks that FFmpeg remaps with -ac.
    # A matching channel count alone does not prove sample-preserving conversion.
    if info.format != "WAV" or info.channels not in (1, 2):
        return False
    point = points[0]
    if (point.elapsed_seconds, point.source_seconds, point.playback_rate, point.key_shift) != (
        0,
        0,
        1,
        0,
    ):
        return False
    if (info.samplerate, info.channels) != (rate, channels):
        return False
    copy_pcm(source, target, cancel, frames=frames, channels=channels)
    return True


def copy_repeated_stereo(source: Path, target: Path, cancel: threading.Event) -> Path | None:
    """Validate every original channel while copying the original first pair once."""
    _check_cancel(cancel)
    repeated = True
    with (
        sf.SoundFile(source) as audio,
        _temporary_wave(target, samplerate=audio.samplerate, channels=2) as output,
    ):
        for block in audio.blocks(blocksize=65536, dtype="float64", always_2d=True):
            _check_cancel(cancel)
            # Float64 retains every PCM32 bit for the original equality check.
            if not np.all(block[:, 2:] == block[:, 1:2]):
                repeated = False
                break
            output.write(block[:, :2])
    if not repeated:
        target.unlink()
        return None
    return target
