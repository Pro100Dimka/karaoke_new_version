"""Fail-closed contracts for frozen, constant-gain audio comparison windows."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import re
from typing import cast

import numpy as np
from numpy.typing import NDArray
import soundfile as sf

AudioArray = NDArray[np.float32]


@dataclass(frozen=True)
class AudioSource:
    path: Path
    sha256: str
    frames: int
    rate: int
    channels: int


@dataclass(frozen=True)
class AuditWindow:
    id: str
    source_id: str
    recording_id: str
    window_id: str
    start: int
    frames: int
    gain: float
    gain_db: float


@dataclass(frozen=True)
class AuditPlan:
    manifest_path: Path
    mapping_path: Path
    manifest_sha256: str
    mapping_sha256: str
    sources: dict[str, AudioSource]
    windows: tuple[AuditWindow, ...]
    rate: int
    channels: int
    target_lufs: float


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def checked_sha256(path: Path, expected: object) -> str:
    if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected):
        raise ValueError(f"Invalid expected SHA256: {path}")
    actual = sha256(path)
    if actual != expected.lower():
        raise ValueError(f"SHA256 mismatch: {path}")
    return actual


def _object(value: object, name: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be a JSON object")
    return cast(dict[str, object], value)


def _text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a nonempty string")
    return value


def _integer(value: object, name: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return value


def _number(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be one finite scalar")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _frozen_object(path: Path, expected: object) -> dict[str, object]:
    checked_sha256(path, expected)
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != str(expected).lower():
        raise ValueError(f"SHA256 changed while reading: {path}")
    return _object(json.loads(data), str(path))


def _source(value: object, expected: object, base: Path, rate: int, channels: int) -> AudioSource:
    data = _object(value, "source")
    path = Path(_text(data.get("path"), "source.path"))
    path = path.resolve() if path.is_absolute() else (base / path).resolve()
    digest = checked_sha256(path, expected)
    if data.get("sha256") != digest:
        raise ValueError(f"Mapping and manifest source SHA256 disagree: {path}")
    frames = _integer(data.get("frames"), "source.frames", 1)
    declared_rate = _integer(data.get("sampleRate"), "source.sampleRate", 1)
    declared_channels = _integer(data.get("channels"), "source.channels", 1)
    info = sf.info(path)
    actual = (info.frames, info.samplerate, info.channels)
    if actual != (frames, rate, channels) or (declared_rate, declared_channels) != (rate, channels):
        raise ValueError(f"Audio format/frames disagree with frozen declaration: {path}")
    return AudioSource(path, digest, frames, rate, channels)


def _sources(
    manifest: dict[str, object], mapping: dict[str, object], base: Path, rate: int, channels: int
) -> dict[str, AudioSource]:
    declared = _object(manifest.get("sourceSha256"), "sourceSha256")
    mapped = _object(mapping.get("sourceConditions"), "sourceConditions")
    if not declared or set(declared) != set(mapped):
        raise ValueError("Manifest and mapping source identifiers disagree")
    if _integer(manifest.get("sourceCount"), "sourceCount", 1) != len(declared):
        raise ValueError("sourceCount does not match sources")
    return {
        key: _source(mapped[key], expected, base, rate, channels)
        for key, expected in declared.items()
    }


def _window(value: object, sources: dict[str, AudioSource], rate: int) -> AuditWindow:
    data = _object(value, "window")
    source_id = _text(data.get("sourceId"), "sourceId")
    if source_id not in sources:
        raise ValueError(f"Unknown sourceId: {source_id}")
    start = _integer(data.get("startFrame"), "startFrame")
    frames = _integer(data.get("frameCount"), "frameCount", 1)
    if frames > rate * 10 or start + frames > sources[source_id].frames:
        raise ValueError("Window exceeds the source or the official 10-second limit")
    if "endFrameExclusive" in data and data["endFrameExclusive"] != start + frames:
        raise ValueError("Window endFrameExclusive is inconsistent")
    gain = _number(data.get("linearGain"), "linearGain")
    gain_db = _number(data.get("gainDb"), "gainDb")
    if gain <= 0 or not math.isclose(gain_db, 20 * math.log10(gain), abs_tol=1e-6):
        raise ValueError("Constant linearGain must be positive and agree with gainDb")
    return AuditWindow(
        _text(data.get("id"), "id"),
        source_id,
        _text(data.get("recordingId"), "recordingId"),
        _text(data.get("windowId"), "windowId"),
        start,
        frames,
        gain,
        gain_db,
    )


def _windows(
    manifest: dict[str, object], sources: dict[str, AudioSource], rate: int
) -> tuple[AuditWindow, ...]:
    values = manifest.get("files")
    if not isinstance(values, list) or not values:
        raise ValueError("files must be a nonempty array")
    if _integer(manifest.get("count"), "count", 1) != len(values):
        raise ValueError("count does not match files")
    windows = tuple(_window(value, sources, rate) for value in values)
    if len({window.id for window in windows}) != len(windows):
        raise ValueError("Duplicate blind window id")
    return windows


def read_window(plan: AuditPlan, window: AuditWindow) -> AudioArray:
    source = plan.sources[window.source_id]
    with sf.SoundFile(source.path) as stream:
        if (len(stream), stream.samplerate, stream.channels) != (
            source.frames,
            plan.rate,
            plan.channels,
        ):
            raise ValueError(f"Audio format/frames changed: {source.path}")
        stream.seek(window.start)
        samples = stream.read(window.frames, dtype="float32", always_2d=True)
    if samples.shape != (window.frames, plan.channels) or not np.isfinite(samples).all():
        raise ValueError(f"Window is short or contains nonfinite samples: {window.id}")
    with np.errstate(over="ignore", invalid="ignore"):
        samples *= np.float32(window.gain)
    if not np.isfinite(samples).all():
        raise ValueError(f"Normalized window contains nonfinite samples: {window.id}")
    if np.max(np.abs(samples)) > 10 ** (-1.3 / 20) + 1e-6:
        raise ValueError(f"Normalized sample peak exceeds frozen -1.3 dB headroom: {window.id}")
    return cast(AudioArray, samples)


def load_plan(manifest_path: Path, mapping_path: Path, expected_sha256: str) -> AuditPlan:
    manifest_path, mapping_path = manifest_path.resolve(), mapping_path.resolve()
    manifest = _frozen_object(manifest_path, expected_sha256)
    mapping_sha = _text(manifest.get("mappingSha256"), "mappingSha256")
    mapping = _frozen_object(mapping_path, mapping_sha)
    rate = _integer(manifest.get("sampleRate"), "sampleRate", 1)
    channels = _integer(manifest.get("channels"), "channels", 1)
    target = _number(manifest.get("commonTargetLufs"), "commonTargetLufs")
    if target > -18:
        raise ValueError("Frozen commonTargetLufs must be <= -18")
    sources = _sources(manifest, mapping, mapping_path.parent, rate, channels)
    windows = _windows(manifest, sources, rate)
    plan = AuditPlan(
        manifest_path,
        mapping_path,
        expected_sha256.lower(),
        mapping_sha,
        sources,
        windows,
        rate,
        channels,
        target,
    )
    for window in windows:
        read_window(plan, window)
    return plan


def verify_plan_unchanged(plan: AuditPlan) -> None:
    checked_sha256(plan.manifest_path, plan.manifest_sha256)
    checked_sha256(plan.mapping_path, plan.mapping_sha256)
    for source in plan.sources.values():
        checked_sha256(source.path, source.sha256)
