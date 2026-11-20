"""Shrink complete dry microphone sources only when their PCM remains bit-exact."""

from __future__ import annotations

import os
import stat
import tempfile
import threading
from dataclasses import dataclass
from inspect import signature
from pathlib import Path

import numpy as np
import soundfile as sf
from numpy.typing import NDArray

_BLOCK_FRAMES = 65536
_FLAC_OPTIONS = (
    {"compression_level": 0.0}
    if "compression_level" in signature(sf.SoundFile).parameters
    else {}
)


@dataclass(frozen=True, slots=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    modified_ns: int
    changed_ns: int


@dataclass(frozen=True, slots=True)
class PreparedSource:
    source: Path
    target: Path
    source_identity: FileIdentity
    target_identity: FileIdentity


def prepare_dry_archive(source: Path, cancel: threading.Event) -> PreparedSource | None:
    """Prepare a smaller verified FLAC, retaining the WAV until its owner can retire it."""
    _check_cancel(cancel)
    dry = Path(str(source.with_suffix(".wav")) + ".dry.wav")
    if not dry.exists():
        return None
    identity = _identity(dry)
    info, mix = sf.info(dry), sf.info(source)
    if (info.frames, info.samplerate, info.channels) != (mix.frames, mix.samplerate, mix.channels):
        raise ValueError("Dry recording source is not synchronized with its mix")
    if info.frames <= 0 or info.channels > 8 or info.subtype not in {"FLOAT", "PCM_16", "PCM_24"}:
        return None
    target = dry.with_suffix(".flac")
    if target.is_symlink():
        raise ValueError("Dry recording archive cannot be an alias")
    if target.exists():
        previous = _identity(target)
        try:
            reusable = previous.size < identity.size and _same_samples(dry, target, cancel)
        except sf.LibsndfileError:
            reusable = False
        if reusable:
            _require_identity(dry, identity)
            _require_identity(target, previous)
            return PreparedSource(dry, target, identity, previous)
    return _prepare_file(dry, target, identity, cancel)


def retire_dry_archive(prepared: PreparedSource) -> None:
    """Called only by the owner's idle publication guard; failed unlink remains retryable."""
    if not prepared.source.exists():
        return
    _require_identity(prepared.source, prepared.source_identity)
    _require_identity(prepared.target, prepared.target_identity)
    prepared.source.unlink()


def _prepare_file(
    source: Path, target: Path, identity: FileIdentity, cancel: threading.Event
) -> PreparedSource | None:
    descriptor, name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".preparing", dir=target.parent
    )
    os.close(descriptor)
    temporary = Path(name)
    try:
        if not _encode(source, temporary, cancel):
            return None
        if temporary.stat().st_size >= identity.size or not _same_samples(source, temporary, cancel):
            return None
        _require_identity(source, identity)
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        _check_cancel(cancel)
        _require_identity(source, identity)
        os.replace(temporary, target)
        return PreparedSource(source, target, identity, _identity(target))
    finally:
        temporary.unlink(missing_ok=True)


def _encode(source: Path, target: Path, cancel: threading.Event) -> bool:
    with sf.SoundFile(source) as original:
        with sf.SoundFile(
            target,
            "w",
            samplerate=original.samplerate,
            channels=original.channels,
            format="FLAC",
            subtype="PCM_24",
            **_FLAC_OPTIONS,
        ) as encoded:
            for block in original.blocks(
                blocksize=_BLOCK_FRAMES, dtype="float32", always_2d=True
            ):
                _check_cancel(cancel)
                if not _pcm24_exact(block):
                    return False
                encoded.write(block)
    _check_cancel(cancel)
    return True


def _pcm24_exact(block: NDArray[np.float32]) -> bool:
    if not np.isfinite(block).all() or np.any(block < -1) or np.any(block >= 1):
        return False
    scaled = block * (1 << 23)
    return bool(
        np.equal(scaled, np.trunc(scaled)).all()
        and not np.any((block == 0) & np.signbit(block))
    )


def _same_samples(source: Path, target: Path, cancel: threading.Event) -> bool:
    with sf.SoundFile(source) as original, sf.SoundFile(target) as encoded:
        if encoded.format != "FLAC" or encoded.subtype != "PCM_24":
            return False
        if (original.frames, original.samplerate, original.channels) != (
            encoded.frames,
            encoded.samplerate,
            encoded.channels,
        ):
            return False
        frames = 0
        for block in original.blocks(blocksize=_BLOCK_FRAMES, dtype="float32", always_2d=True):
            _check_cancel(cancel)
            actual = encoded.read(len(block), dtype="float32", always_2d=True)
            if not np.array_equal(block.view(np.uint32), actual.view(np.uint32)):
                return False
            frames += len(block)
        _check_cancel(cancel)
        return frames == original.frames and not encoded.read(1).size


def _identity(path: Path) -> FileIdentity:
    info = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode) or path.resolve() != path.absolute():
        raise ValueError("Dry recording source cannot be an alias")
    return FileIdentity(info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _require_identity(path: Path, expected: FileIdentity) -> None:
    try:
        if _identity(path) == expected:
            return
    except FileNotFoundError:
        pass
    raise ValueError("Verified dry recording source or archive changed or is missing")


def _check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise InterruptedError("Dry recording archival was cancelled")
