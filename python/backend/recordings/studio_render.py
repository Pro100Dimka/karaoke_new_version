"""Adaptive AD Master: one explicit edit → inserts → mix → delivery path."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
import os
import shutil
import threading
from tempfile import TemporaryDirectory
from time import perf_counter

import numpy as np
from numpy.typing import NDArray
import soundfile as sf

from backend.domain_errors import DependencyError
from backend.recordings.studio_audio import (
    MasterRenderer,
    StudioMasterBalance,
    _check_cancel,
    _profile,
)
from backend.recordings.studio_adaptive_timing import align_voice
from backend.recordings.studio_adaptive_voice import prepare_voice, process_voice
from backend.recordings.studio_voice_analysis import VoiceAnalysisCache
from backend.recordings.studio_adaptive_mix import mix_and_master
from backend.recordings.studio_arrangement import ArrangementMap, analyze_arrangement
from backend.recordings.studio_pitch import PitchAnalyzer, apply_reference_pitch
from backend.recordings.studio_quality import inspect_master
from backend.recordings.studio_sources import IDENTITY_TIMELINE, MasterSources, prepare_sources


@dataclass(slots=True)
class MasterRender:
    renderer: MasterRenderer
    user_vocal: Path
    performance_instrumental: Path
    reference_vocal: Path
    original_instrumental: Path
    target: Path
    cancel: threading.Event
    performance_mix: Path
    exact_stems: bool
    process_voice: bool
    match_recording_loudness: bool
    adjustments: Sequence[Mapping[str, object]]
    progress: Callable[[str, float, float], None] | None
    pitch: PitchAnalyzer | None = None
    original_mix: Path | None = None
    info: sf._SoundFileInfo = field(init=False)
    work: Path = field(init=False)
    sources: MasterSources = field(init=False)
    arrangement: ArrangementMap = field(init=False)
    backing: Path = field(init=False)
    vocal: Path = field(init=False)
    balanced: Path = field(init=False)
    output_channels: int = field(init=False)
    processing: dict[str, object] = field(init=False)
    voice_db: NDArray[np.float64] = field(init=False)
    backing_db: NDArray[np.float64] = field(init=False)
    reference_db: NDArray[np.float64] = field(init=False)
    original_db: NDArray[np.float64] = field(init=False)
    gains: NDArray[np.float64] = field(init=False)
    reliable: NDArray[np.bool_] = field(init=False)
    timing_known: bool = field(init=False)
    pitch_adjustments: Sequence[Mapping[str, object]] = field(init=False)
    offset_result: tuple[float, float] | None = field(default=None, init=False)
    reference_origin: float = field(default=0.0, init=False)
    stage_seconds: dict[str, float] = field(default_factory=dict, init=False)
    voice_analysis: VoiceAnalysisCache = field(default_factory=VoiceAnalysisCache, init=False)

    def run(self) -> StudioMasterBalance:
        self._validate_destination()
        started = perf_counter()
        with TemporaryDirectory(prefix=".master-", dir=self.target.parent) as directory:
            self.work = Path(directory)
            self.processing = self._initial_report()
            self._stage("sources", "PreparingStudioSources", 0.58, self._prepare_stems)
            self._stage("arrangement", "PreparingStudioSources", 0.60, self._arrange)
            self._analyze()
            self._stage("alignment", "AligningStudioVoice", 0.61, self._align)
            self._stage("preparation", "PreparingStudioVoice", 0.64, self._prepare_voice)
            before = perf_counter()
            self.processing["pitchCorrection"] = apply_reference_pitch(self)
            self.stage_seconds["pitch"] = perf_counter() - before
            self._stage("vocalInserts", "ProcessingStudioVoice", 0.73, self._finish_voice)
            self._stage("mixAndMaster", "MixingStudioMaster", 0.82, self._deliver)
            self.processing["stageSeconds"] = self.stage_seconds
            self.processing["elapsedSeconds"] = perf_counter() - started
            return self._balance_report()

    def _validate_destination(self) -> None:
        _check_cancel(self.cancel)
        inputs: tuple[Path, ...] = (
            self.user_vocal,
            self.performance_instrumental,
            self.reference_vocal,
            self.original_instrumental,
            self.performance_mix,
        )
        if self.original_mix is not None:
            inputs += (self.original_mix,)
        if self.target.resolve() in [path.resolve() for path in inputs]:
            raise DependencyError("StudioMasterInvalidTarget", "Master cannot overwrite a source")
        self.info = sf.info(self.performance_mix)
        if not self.info.frames:
            raise DependencyError("StudioMasterInvalidAudio", "Recording contains no audio")
        self.target.parent.mkdir(parents=True, exist_ok=True)
        if (
            shutil.disk_usage(self.target.parent).free
            < self.info.frames * self.info.channels * 64 + 64 * 1024**2
        ):
            raise DependencyError("InsufficientDiskSpace", "Not enough space for studio processing")

    def _initial_report(self) -> dict[str, object]:
        return {
            "pipeline": "adaptive-studio-v2",
            "version": 2,
            "vocalSource": "dry" if self.process_voice else "existing-effects",
            "order": [
                "timeline",
                "arrangement",
                "noiseAndClipGain",
                "pitch",
                "subtractiveEq",
                "peakCompression",
                "levelCompression",
                "deEssing",
                "toneEq",
                "saturation",
                "sectionBalance",
                "dynamicBackingEq",
                "parallelSpaceSends",
                "masterGlue",
                "truePeakLimiter",
                "verification",
            ],
        }

    def _stage(self, name: str, stage: str, value: float, action: Callable[[], None]) -> None:
        _check_cancel(self.cancel)
        if self.progress:
            self.progress(stage, 0.0, value)
        started = perf_counter()
        action()
        self.stage_seconds[name] = perf_counter() - started

    def _prepare_stems(self) -> None:
        self.sources = prepare_sources(
            self.renderer,
            self.user_vocal,
            self.performance_instrumental,
            self.reference_vocal,
            self.original_instrumental,
            self.performance_mix,
            self.work,
            self.cancel,
            self.adjustments,
            exact_stems=self.exact_stems,
            original_mix=self.original_mix,
        )
        self.output_channels = self.sources.channels
        self.user_vocal, self.vocal, self.backing = (
            self.sources.vocal,
            self.sources.vocal,
            self.sources.backing,
        )
        self.timing_known = self.sources.reference_vocal is not None
        if self.sources.reference_vocal is not None:
            self.reference_vocal = self.sources.reference_vocal
        if self.sources.reference_backing is not None:
            self.original_instrumental = self.sources.reference_backing
        self.processing.update(self.sources.report)
        self.processing["playbackAdjustments"] = list(self.adjustments)
        # The reference has already been mapped through seeks, tempo and key exactly
        # once. Pitch analysis must not apply those changes for a second time.
        self.adjustments = self.pitch_adjustments = IDENTITY_TIMELINE if self.timing_known else ()

    def _arrange(self) -> None:
        self.arrangement = analyze_arrangement(
            self.backing,
            self.sources.reference_vocal,
            self.cancel,
            reference_intervals=self.sources.reference_intervals,
        )
        self.processing["arrangement"] = self.arrangement.payload()

    def _analyze(self) -> None:
        self.voice_db = _profile(self.vocal, self.cancel)
        self.backing_db = _profile(self.backing, self.cancel)
        self.reference_db = (
            _profile(self.sources.reference_vocal, self.cancel)
            if self.sources.reference_vocal is not None
            else np.full_like(self.voice_db, -120)
        )
        self.original_db = (
            _profile(self.sources.reference_backing, self.cancel)
            if self.sources.reference_backing is not None
            else np.full_like(self.voice_db, -120)
        )
        self.gains = np.zeros_like(self.voice_db)
        self.reliable = self.voice_db > max(-100, float(np.percentile(self.voice_db, 90)) - 45)
        # No minimum phrase duration: a short take is still a performance.

    def _align(self) -> None:
        target = self.work / "aligned-vocal.wav"
        result = align_voice(self.vocal, self.sources.reference_vocal, target, self.cancel)
        self.processing["timing"] = result
        self.processing["voiceShiftMs"] = result["shiftMs"]
        self.vocal = target

    def _prepare_voice(self) -> None:
        target = self.work / "edited-vocal.wav"
        self.processing["preparation"] = prepare_voice(
            self.renderer,
            self.vocal,
            target,
            self.cancel,
            reference=self.sources.reference_vocal,
            analysis=self.voice_analysis,
        )
        self.vocal = target
        self.voice_db = _profile(target, self.cancel)
        self.reliable = self.voice_db > max(-100, float(np.percentile(self.voice_db, 90)) - 45)

    def _finish_voice(self) -> None:
        target = self.work / "processed-vocal.wav"
        self.processing["vocalChain"] = process_voice(
            self.renderer,
            self.vocal,
            target,
            self.cancel,
            reference=self.sources.reference_vocal,
            arrangement=self.arrangement,
            analysis=self.voice_analysis,
        )
        self.vocal = self.balanced = target

    def _deliver(self) -> None:
        target = self.work / "verified-master.wav"
        result = mix_and_master(
            self.renderer,
            self.balanced,
            self.backing,
            target,
            self.cancel,
            reference_vocal=self.sources.reference_vocal,
            reference_backing=self.sources.reference_backing,
            original_mix=self.sources.original_mix,
            recorded_is_dry=self.process_voice,
            arrangement=self.arrangement,
            progress=self.progress,
        )
        self.processing.update(
            mix=result,
            delivery=result["delivery"],
            gainPlan=result["balance"],
            referenceEffects=result["space"],
            backingEq=result["backingEq"],
        )
        self.processing["qualityControl"] = inspect_master(
            target,
            expected_frames=self.sources.frames,
            expected_rate=self.sources.rate,
            expected_channels=self.sources.channels,
        )
        _check_cancel(self.cancel)
        os.replace(target, self.target)

    def _balance_report(self) -> StudioMasterBalance:
        levels = [
            float(np.median(values[values > -100])) if np.any(values > -100) else -120.0
            for values in (self.voice_db, self.backing_db, self.reference_db, self.original_db)
        ]
        balance = self.processing.get("gainPlan", {})
        gain = float(balance.get("medianGainDb", 0.0)) if isinstance(balance, dict) else 0.0
        fraction = (
            float(balance.get("referenceMatchedFraction", 0.0))
            if isinstance(balance, dict)
            else 0.0
        )
        return StudioMasterBalance(
            gain, levels[0], levels[1], levels[2], levels[3], fraction, self.processing
        )
