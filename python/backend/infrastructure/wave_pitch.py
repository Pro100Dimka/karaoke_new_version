from __future__ import annotations

import wave
import threading
import logging
import math
from dataclasses import replace
from contextlib import contextmanager
from contextvars import ContextVar
from collections.abc import Iterator
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf
from scipy import signal

from backend.ai.domain import AiCapability, PitchPoint
from backend.ai.ports import AiProvider
from backend.domain_errors import ConflictError, DomainError
from backend.infrastructure.local_storage import LocalWorkStorage
from backend.models.domain import ComputeMode
from backend.processing.preflight import ProcessingPreflight, provider_backend
from backend.processing.resource_scheduler import ProcessingResourceScheduler, ResourceLease
from backend.settings.domain import ProcessingBackend
from backend.settings.queries import GetSettings

# Windows read per block: memory stays bounded by this many windows of audio whatever the length
# of the take (a whole take used to be unpacked into Python integers and ran out of memory).
_WINDOWS_PER_BLOCK = 512
_SILENCE_PEAK = 200
_LOWEST_HZ = 50.0
_HIGHEST_HZ = 1400.0
_FULL_CONFIDENCE_PEAK = 8000.0
_COMPARISON_RATE = 4000
logger = logging.getLogger(__name__)


class VocalPitchExtractor:
    """Analyze separated performance and reference vocals under the configured AI budget."""

    def __init__(
        self,
        preflight: ProcessingPreflight,
        settings: GetSettings,
        resources: ProcessingResourceScheduler,
        workspaces: LocalWorkStorage,
    ) -> None:
        self._preflight = preflight
        self._settings = settings
        self._resources = resources
        self._workspaces = workspaces
        self._admitted: ContextVar[tuple[AiProvider, AiProvider, ResourceLease] | None] = ContextVar(
            "vocal_analysis_resources", default=None
        )

    @contextmanager
    def admit(self, recording: Path, cancel: threading.Event) -> Iterator[None]:
        while True:
            if cancel.is_set():
                raise ConflictError("JobCancelled", "Recording analysis was cancelled")
            try:
                providers = self._claim(recording)
                break
            except DomainError as exc:
                if exc.code != "ResourceBudgetExceeded":
                    raise
                cancel.wait(0.1)
        token = self._admitted.set(providers)
        try:
            yield
        finally:
            self._admitted.reset(token)
            providers[2].release()

    def extract_vocals(
        self,
        recording: Path,
        reference: Path,
        cancel: threading.Event,
        progress: Callable[[str, float, float], None],
        *,
        reference_start: float | None = 0.0,
    ) -> tuple[tuple[PitchPoint, ...], tuple[PitchPoint, ...]]:
        admitted = self._admitted.get()
        separation, pitch, lease = admitted or self._claim(recording)
        workspace = None
        try:
            progress("AnalyzingTiming", 0.0, 0.02)
            delay = (
                loopback_offset(recording, reference, reference_start, cancel)
                if reference_start is not None
                else 0.0
            )
            logger.info("Performance residual timing", extra={"delaySeconds": delay})
            workspace = self._workspaces.allocate("analysis")
            progress("SeparatingPerformance", 0.0, 0.05)
            separated = separation.separate(
                recording,
                workspace / "separation",
                cancel,
                execution=lease.execution,
            )
            progress("PitchAnalysis", 0.0, 0.4)
            actual = pitch.pitch(separated.reference_vocal, cancel, execution=lease.execution)
            progress("ReferencePitchAnalysis", 0.0, 0.7)
            expected = pitch.pitch(reference, cancel, execution=lease.execution)
            return tuple(replace(point, time=point.time - delay) for point in actual), tuple(
                expected
            )
        finally:
            if admitted is None:
                lease.release()
            if workspace is not None:
                self._workspaces.cleanup(workspace)

    def _claim(self, recording: Path) -> tuple[AiProvider, AiProvider, ResourceLease]:
        settings = self._settings.execute()
        separation = self._preflight.resolve(settings, AiCapability.SEPARATION)
        pitch = self._preflight.resolve(settings, AiCapability.PITCH)
        mode = (
            ComputeMode.CPU
            if provider_backend(separation) is ProcessingBackend.KAGGLE
            else settings.compute_mode
        )
        lease = self._resources.claim_provider(
            separation,
            recording.stat().st_size,
            mode,
            cpu_threads=settings.cpu_threads,
            additional_providers=(pitch,),
        )
        return separation, pitch, lease


def loopback_offset(
    recording: Path,
    reference: Path,
    reference_start: float = 0.0,
    cancel: threading.Event | None = None,
) -> float:
    """Measure a residual delay only from repeated, unambiguous copies of the original waveform.

    A singer's note/onset resemblance is not calibration evidence: never optimize their rhythm away.
    """
    with sf.SoundFile(recording) as captured, sf.SoundFile(reference) as original:
        duration = min(
            len(captured) / captured.samplerate,
            len(original) / original.samplerate - reference_start,
        )
        if duration < 12:
            return 0.0
        offsets = []
        for start in np.linspace(0.5, duration - 4.5, 5):
            if cancel is not None and cancel.is_set():
                raise ConflictError("JobCancelled", "Recording analysis was cancelled")
            actual = _comparison_audio(captured, float(start), 4)
            target = _comparison_audio(original, reference_start + float(start) - 0.5, 5)
            offset = _copy_delay(actual, target)
            if offset is not None:
                offsets.append(offset)
    groups = [[other for other in offsets if abs(other - offset) <= 0.002] for offset in offsets]
    best = max(groups, key=len, default=[])
    return float(np.median(best)) if len(best) >= 3 else 0.0


def _comparison_audio(stream: sf.SoundFile, start: float, duration: float) -> np.ndarray:
    stream.seek(round(start * stream.samplerate))
    samples = stream.read(
        round(duration * stream.samplerate), dtype="float32", always_2d=True
    ).mean(axis=1)
    divisor = math.gcd(stream.samplerate, _COMPARISON_RATE)
    samples = signal.resample_poly(
        samples, _COMPARISON_RATE // divisor, stream.samplerate // divisor
    )
    band = signal.butter(3, [90, 1800], fs=_COMPARISON_RATE, btype="bandpass", output="sos")
    return np.asarray(signal.sosfiltfilt(band, samples))


def _copy_delay(actual: np.ndarray, reference: np.ndarray) -> float | None:
    correlation = signal.correlate(reference, actual, mode="valid", method="fft")
    energy = signal.correlate(reference**2, np.ones(len(actual)), mode="valid", method="fft")
    correlation = np.abs(correlation) / np.sqrt(np.maximum(energy * np.sum(actual**2), 1e-20))
    peak = int(np.argmax(correlation))
    # Repeating tones can correlate at many lags. Such an ambiguous peak says nothing about latency.
    alternatives = correlation[
        np.abs(np.arange(len(correlation)) - peak) > _COMPARISON_RATE * 0.006
    ]
    if correlation[peak] < 0.45 or correlation[peak] < np.max(alternatives, initial=0) * 1.3:
        return None
    return 0.5 - peak / _COMPARISON_RATE


class WavePitchExtractor:
    def __init__(self, window_seconds: float = 0.05) -> None:
        self._window_seconds = window_seconds

    def extract(self, path: Path) -> tuple[PitchPoint, ...]:
        try:
            with wave.open(str(path), "rb") as audio:
                if audio.getsampwidth() != 2:
                    raise DomainError(
                        "AnalysisFailed", "Only 16-bit PCM recordings are supported", 422
                    )
                channels = audio.getnchannels()
                if channels <= 0:
                    raise DomainError("AnalysisFailed", "Recording channel count is invalid", 422)
                rate = audio.getframerate()
                window = max(64, int(rate * self._window_seconds))
                points: list[PitchPoint] = []
                start = 0
                while block := audio.readframes(window * _WINDOWS_PER_BLOCK):
                    samples = np.frombuffer(block, dtype="<i2")[::channels]
                    points.extend(_block_pitch(samples, rate, window, start))
                    start += len(samples)
        except (OSError, EOFError, wave.Error) as exc:
            raise DomainError("AnalysisFailed", "Recording audio cannot be decoded", 422) from exc
        return tuple(points)


def _block_pitch(samples: np.ndarray, rate: int, window: int, start: int) -> list[PitchPoint]:
    """One point per window: the zero-crossing frequency of the first channel."""
    points: list[PitchPoint] = []
    for offset in range(0, len(samples), window):
        chunk = samples[offset : offset + window].astype(np.int32)
        time = (start + offset) / rate
        if len(chunk) < 2:
            points.append(PitchPoint(time, 0.0, 0.0))
            continue
        peak = int(np.abs(chunk).max())
        if peak < _SILENCE_PEAK:
            points.append(PitchPoint(time, 0.0, 0.0))
            continue
        crossings = int(np.count_nonzero((chunk[:-1] <= 0) & (chunk[1:] > 0)))
        frequency = crossings / (len(chunk) / rate)
        if not _LOWEST_HZ <= frequency <= _HIGHEST_HZ:
            points.append(PitchPoint(time, 0.0, 0.0))
            continue
        points.append(PitchPoint(time, frequency, min(1.0, peak / _FULL_CONFIDENCE_PEAK)))
    return points
