from __future__ import annotations
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_quality import inspect_master
from backend.recordings.studio_space import apply_reference_space, apply_fallback_space
from backend.recordings.studio_dynamics import _backing_curve
from backend.recordings.studio_voice import VoicePreparation, apply_reference_tone
from numpy.typing import NDArray
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
import shutil
import threading
from tempfile import TemporaryDirectory
import numpy as np
import soundfile as sf
from backend.analysis.scoring import reference_audio_start
from backend.domain_errors import DependencyError
from backend.recordings.studio_pitch import PitchAnalyzer, apply_reference_pitch
from backend.recordings.studio_audio import (
    StudioMasterBalance,
    _PROFILE_SECONDS,
    _VOCAL_TARGET_OFFSET_DB,
    _check_cancel,
    _profile,
)
from dataclasses import dataclass, field
from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_reference import scope_reference, mapped_reference_times
from backend.recordings.studio_calibration import calibrate_mix


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
    info: sf._SoundFileInfo = field(init=False)
    work: Path = field(init=False)
    backing: Path = field(init=False)
    output_channels: int = field(init=False)
    processing: dict[str, object] = field(init=False)
    vocal: Path = field(init=False)
    voice_db: NDArray[np.float64] = field(init=False)
    backing_db: NDArray[np.float64] = field(init=False)
    reference_db: NDArray[np.float64] = field(init=False)
    original_db: NDArray[np.float64] = field(init=False)
    offset_result: tuple[float, float] | None = field(init=False)
    times: NDArray[np.floating] = field(init=False)
    source_times: NDArray[np.floating] = field(init=False)
    timing_known: bool = field(init=False)
    gains: NDArray[np.float64] = field(init=False)
    reliable: NDArray[np.bool_] = field(init=False)
    pitch_adjustments: Sequence[Mapping[str, object]] = field(init=False)
    balanced: Path = field(init=False)
    peak_bound: float = field(init=False)
    voice_gain_db: float = field(default=0, init=False)
    reference_origin: float = field(default=0, init=False)

    def run(self) -> StudioMasterBalance:
        self.info = sf.info(self.performance_mix)
        self.target.parent.mkdir(parents=True, exist_ok=True)
        if (
            shutil.disk_usage(self.target.parent).free
            < self.info.frames * self.info.channels * 20 + 64 * 1024**2
        ):
            raise DependencyError(
                "InsufficientDiskSpace", "Not enough space for recording stems and master"
            )
        with (
            TemporaryDirectory(prefix=".master-", dir=self.target.parent) as directory,
        ):
            self.work = Path(directory)
            self._prepare_stems()
            self._scope_reference()
            bypass = self._analyze()
            if bypass is not None:
                return bypass
            bypass = self._match_reference()
            if bypass is not None:
                return bypass
            self._finish_voice()
            self.processing["pitchCorrection"] = apply_reference_pitch(self)
            self._write_balanced()
            self._unmask()
            self._deliver()
            self._calibrate()
            self.processing["qualityControl"] = inspect_master(
                self.target,
                expected_frames=self.info.frames,
                expected_rate=self.info.samplerate,
                expected_channels=self.output_channels,
            )
            return self._balance_report()

    def _calibrate(self) -> None:
        mapped = np.asarray(self.source_times, dtype=np.float64)
        section = None
        if (
            self.timing_known
            and len(mapped) >= 2
            and np.all(np.isfinite(mapped))
            and np.all((np.diff(mapped) > 0) & (np.diff(mapped) < 2 * _PROFILE_SECONDS))
        ):
            start = max(0.0, float(mapped[0] - _PROFILE_SECONDS / 2))
            end = min(
                sf.info(self.reference_vocal).duration, float(mapped[-1] + _PROFILE_SECONDS / 2)
            )
            if end > start:
                section = (start, end)
        self.voice_gain_db = calibrate_mix(
            self.balanced,
            self.backing,
            self.target,
            self.reference_vocal,
            self.original_instrumental,
            section,
            self._redeliver,
            self.processing,
            vocal_offset_db=_VOCAL_TARGET_OFFSET_DB,
        )

    def _redeliver(self, gain: float) -> None:
        self.voice_gain_db = gain
        self._deliver()

    def _prepare_stems(self) -> None:
        self.backing = self.performance_instrumental
        self.output_channels = self.info.channels
        for path in (self.user_vocal, self.backing):
            stem = sf.info(path)
            if stem.samplerate != self.info.samplerate or stem.frames != self.info.frames:
                raise DependencyError(
                    "StudioMasterStemMismatch",
                    "Recording and stems must have matching sample rate and duration",
                )
        if (
            self.exact_stems
            and self.info.channels > 2
            and self.renderer._repeated_output_channels(self.user_vocal, self.cancel)
            and self.renderer._repeated_output_channels(self.backing, self.cancel)
        ):
            self._stereo_stems()
        if not self.exact_stems:
            self.backing = self.work / "residual.wav"
            self.renderer._mix(
                self.performance_mix,
                self.user_vocal,
                "[1:a]volume=-1[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[out]",
                ["-ar", str(self.info.samplerate), "-c:a", "pcm_f32le", str(self.backing)],
                self.cancel,
            )
        self.processing: dict[str, object] = {
            "voiceShiftMs": 0.0,
            "vocalSource": "dry" if self.process_voice else "existing-effects-preserved",
            "effectsApplied": self.process_voice,
            "outputChannels": self.output_channels,
        }

    def _analyze(self) -> StudioMasterBalance | None:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="master-analysis") as pool:
            profile_tasks = [
                pool.submit(_profile, path, self.cancel)
                for path in (self.backing, self.reference_vocal, self.original_instrumental)
            ]
            origin = reference_audio_start(self.adjustments)
            alignment = pool.submit(
                self.renderer._reference_offset,
                self.backing,
                self.original_instrumental,
                origin - self.reference_origin if origin is not None else None,
                self.cancel,
            )
            self.vocal = self.user_vocal
            bypass = self._prepare_voice(profile_tasks)
            if bypass is not None:
                return bypass
            if self.progress:
                self.progress("AnalyzingBalance", 0.3, 0.65)
            self.voice_db = _profile(self.vocal, self.cancel)
            self.backing_db, self.reference_db, self.original_db = (
                future.result() for future in profile_tasks
            )
            self.offset_result = alignment.result() if alignment is not None else None
        return None

    def _scope_reference(self) -> None:
        self.pitch_adjustments = self.adjustments
        self.reference_vocal, self.original_instrumental, self.reference_origin, report = (
            scope_reference(
                self.reference_vocal,
                self.original_instrumental,
                self.adjustments,
                self.info.duration,
                self.work,
                self.cancel,
            )
        )
        self.processing.update(report)
        if report.get("referenceTimelineRebuilt"):
            self.adjustments = [
                {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0}
            ]

    def _match_reference(self) -> StudioMasterBalance | None:
        # Match the audit's vocal band so bass energy does not set the lead level.
        self.voice_db, self.backing_db, self.reference_db, self.original_db = (
            _profile(path, self.cancel, voice_band=True)
            for path in (self.vocal, self.backing, self.reference_vocal, self.original_instrumental)
        )
        self.processing.update(
            balanceBandHz=[300, min(3500, self.info.samplerate / 2)],
            vocalTargetOffsetDb=_VOCAL_TARGET_OFFSET_DB,
        )
        self._map_reference_time()
        profiles = []
        for levels, positions in (
            (self.backing_db, self.times),
            (self.reference_db, self.source_times),
            (self.original_db, self.source_times),
        ):
            axis = (np.arange(len(levels)) + 0.5) * _PROFILE_SECONDS
            profiles.append(np.interp(positions, axis, levels, left=-120, right=-120))
        self.backing_db, self.reference_db, self.original_db = profiles
        self.gains, self.reliable = self.renderer._balance_curve(
            self.voice_db,
            self.backing_db,
            self.reference_db,
            self.original_db,
            phrase_smoothing=True,
        )
        if not self.timing_known or not self.reliable.any():
            self.gains.fill(0.0)
            self.reliable.fill(False)
            self.processing["balanceFallback"] = "reference-stem-distribution"
        return None

    def _match_backing(self) -> None:
        gains = _backing_curve(self.backing_db, self.original_db)
        if not np.any(gains):
            return
        target = self.work / "balanced-backing.wav"
        with (
            sf.SoundFile(self.backing) as source,
            sf.SoundFile(
                target, "w", samplerate=source.samplerate, channels=source.channels, subtype="FLOAT"
            ) as output,
        ):
            offset = 0
            for samples in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
                _check_cancel(self.cancel)
                positions = (offset + np.arange(len(samples))) / source.samplerate
                gain = np.power(10.0, np.interp(positions, self.times, gains) / 20)
                output.write(samples * gain[:, None])
                offset += len(samples)
        self.backing = target
        self.backing_db = self.backing_db + gains
        self.processing["backingGainDb"] = float(np.median(gains))
        self.processing["backingBalance"] = "original-instrumental-envelope"

    def _write_balanced(self) -> None:
        self.balanced = self.work / "balanced-voice.wav"
        self.peak_bound = 0.0
        with (
            sf.SoundFile(self.vocal) as source,
            sf.SoundFile(
                self.balanced,
                "w",
                samplerate=source.samplerate,
                channels=source.channels,
                subtype="FLOAT",
            ) as output,
        ):
            offset = 0
            for samples in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
                _check_cancel(self.cancel)
                positions = (offset + np.arange(len(samples))) / source.samplerate
                gain = np.power(10.0, np.interp(positions, self.times, self.gains) / 20)
                adjusted = samples * gain[:, None]
                output.write(adjusted)
                offset += len(samples)

    def _unmask(self) -> None:
        active = self._voice_activity()
        self.processing["maskingActivitySource"] = "performance-vocal-envelope"
        unmasked = self.work / "unmasked-backing.wav"
        self.processing["spectralBalance"] = self.renderer._unmask_backing(
            self.backing,
            self.balanced,
            unmasked,
            active,
            self.cancel,
            reference_vocal=self.reference_vocal if self.timing_known else None,
            reference_backing=self.original_instrumental if self.timing_known else None,
        )
        self.backing = unmasked

    def _voice_activity(self) -> NDArray[np.bool_]:
        levels = self.voice_db
        floor = float(np.percentile(levels, 20))
        threshold = max(-48.0, floor + 9.0, float(np.percentile(levels, 85)) - 22.0)
        active = levels > threshold
        if not np.any(active) and np.any(levels > -90.0):
            threshold = float(np.percentile(levels, 50))
            active = levels >= threshold
        self.processing["maskingActivityThresholdDbfs"] = threshold
        return active

    def _fallback_balance(self) -> None:
        self.gains.fill(0.0)
        self.processing["balanceFallback"] = "unconfirmed-reference-unity"

    def _finish_voice(self) -> None:
        spatial = self.work / "spatial-voice.wav"
        reference_effects = apply_reference_space(
            self.renderer,
            self.reference_vocal,
            self.user_vocal,
            self.vocal,
            spatial,
            self.cancel,
        )
        self.processing["referenceEffects"] = reference_effects
        if not spatial.is_file():
            self.processing["fallbackEffects"] = apply_fallback_space(
                self.renderer, self.vocal, self.backing, spatial, self.cancel
            )
        if spatial.is_file():
            self.vocal = spatial
            self.processing["toneCohesion"] = apply_reference_tone(
                self.renderer, self.vocal, self.reference_vocal, self.cancel
            )
            matched = reference_effects.get("status") == "matched"
            self.processing["space"] = (
                "reference-matched" if matched else "unchanged-no-supported-effects"
            )
            self.voice_db = _profile(self.vocal, self.cancel, voice_band=True)
            if self.reliable.any():
                self.gains, self.reliable = self.renderer._balance_curve(
                    self.voice_db,
                    self.backing_db,
                    self.reference_db,
                    self.original_db,
                    phrase_smoothing=True,
                )
        self._report_voice(reference_effects)

    def _report_voice(self, reference_effects: dict[str, object]) -> None:
        if self.reliable.any():
            target = self.voice_db + self.gains
            self.processing["voiceBalanceTargetDb"] = float(
                np.median((target - self.backing_db)[self.reliable])
            )
            self.processing["voiceLeveling"] = "post-effects-reference-envelope"
        else:
            self._fallback_balance()
            self.processing["voiceLeveling"] = "bounded-song-level-fallback"
        self.processing["vocalPresence"] = {"method": "single-aligned-phrase-envelope"}
        self.processing["voiceOutputGainDb"] = self.voice_gain_db
        spatial_applied = reference_effects.get("status") == "matched"
        fallback_effects = self.processing.get("fallbackEffects", {})
        if isinstance(fallback_effects, dict):
            spatial_applied = spatial_applied or bool(fallback_effects.get("applied", False))
        self.processing["spaceAudible"] = None  # Requires a listening/perceptual test.
        self.processing["effectsApplied"] = bool(spatial_applied)
        self.processing["adaptive"] = {
            "referenceTimingTrusted": bool(self.timing_known),
            "referenceMatchedFraction": float(np.mean(self.reliable)),
            "equalization": "reference-informed-vocal-filters",
            "compression": "recording-dynamics-adaptive",
            "space": reference_effects.get("status", "not-applied"),
            "backingGain": "unity",
            "masking": "bounded-dynamic-eq-with-voice-activity",
        }

    def _balance_report(self) -> StudioMasterBalance:
        output_info = sf.info(self.target)
        if (output_info.frames, output_info.samplerate, output_info.channels) != (
            self.info.frames,
            self.info.samplerate,
            self.output_channels,
        ):
            raise DependencyError("StudioMasterInvalidAudio", "Master changed the recording length")
        voice_level, backing_level, reference_level, original_level = (
            float(np.median(values[self.reliable]))
            if self.reliable.any()
            else float(np.median(values))
            for values in (self.voice_db, self.backing_db, self.reference_db, self.original_db)
        )
        return StudioMasterBalance(
            float(np.median(self.gains[self.reliable])) if self.reliable.any() else 0,
            voice_level,
            backing_level,
            reference_level,
            original_level,
            float(np.mean(self.reliable)),
            self.processing,
        )

    def _deliver(self) -> None:
        MasterDelivery(
            self.renderer,
            self.backing,
            self.balanced,
            self.target,
            self.cancel,
            self.info,
            self.output_channels,
            self.process_voice,
            self.match_recording_loudness,
            None,
            self.peak_bound,
            self.reliable,
            self.processing,
            self.progress,
            voice_gain_db=self.voice_gain_db,
        ).run()

    def _stereo_stems(self) -> None:
        self.renderer._mix(
            self.user_vocal,
            self.backing,
            "[0:a]pan=stereo|c0=c0|c1=c1[out];[1:a]pan=stereo|c0=c0|c1=c1[music]",
            [
                "-c:a",
                "pcm_f32le",
                str(self.work / "dry-stereo.wav"),
                "-map",
                "[music]",
                "-c:a",
                "pcm_f32le",
                str(self.work / "backing-stereo.wav"),
            ],
            self.cancel,
        )
        self.user_vocal, self.backing = (
            self.work / "dry-stereo.wav",
            self.work / "backing-stereo.wav",
        )
        self.output_channels = 2

    def _prepare_voice(
        self, profile_tasks: list[Future[NDArray[np.float64]]]
    ) -> StudioMasterBalance | None:
        raw_profile = _profile(self.user_vocal, self.cancel)
        confident = raw_profile > max(-80.0, float(np.percentile(raw_profile, 90)) - 25)
        if np.count_nonzero(confident) * _PROFILE_SECONDS < 3:
            shutil.copyfile(self.performance_mix, self.target)
            profiles = [raw_profile, *(future.result() for future in profile_tasks)]
            voice_level, backing_level, reference_level, original_level = map(
                lambda levels: float(np.median(levels)),
                profiles,
            )
            return StudioMasterBalance(
                0,
                voice_level,
                backing_level,
                reference_level,
                original_level,
                0,
                processing={
                    "effectsApplied": False,
                    "bypassReason": "insufficient-vocal-evidence",
                    "outputChannels": self.info.channels,
                },
            )
        self.vocal = self.work / "processed-voice.wav"
        self.processing.update(
            VoicePreparation(
                self.renderer,
                self.user_vocal,
                self.backing,
                self.reference_vocal,
                self.vocal,
                self.info,
                self.output_channels,
                self.cancel,
            ).run(raw_profile, profile_tasks[1].result())
        )
        return None

    def _map_reference_time(self) -> None:
        self.times = (np.arange(len(self.voice_db)) + 0.5) * _PROFILE_SECONDS
        self.source_times, self.timing_known, report = mapped_reference_times(
            self.times,
            self.adjustments,
            self.offset_result,
            self.reference_origin,
        )
        self.processing.update(report)
