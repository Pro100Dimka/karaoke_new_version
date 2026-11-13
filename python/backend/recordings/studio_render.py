from __future__ import annotations
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_quality import inspect_master
from backend.recordings.studio_space import apply_reference_space
from numpy.typing import NDArray
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
import shutil
import threading
from tempfile import TemporaryDirectory
import numpy as np
import soundfile as sf
from backend.analysis.scoring import reference_audio_start, parse_playback_adjustments
from backend.domain_errors import DependencyError
from backend.recordings.studio_pitch import PitchAnalyzer, apply_reference_pitch
from backend.recordings.studio_audio import (
    StudioMasterBalance,
    _PROFILE_SECONDS,
    _profile,
    _write_gain_envelope,
)
from dataclasses import dataclass, field
from backend.recordings.studio_audio import MasterRenderer
from backend.recordings.studio_reference import (
    scope_reference,
    mapped_reference_times,
    verified_backing_gain,
)
from backend.recordings.studio_calibration import (
    GainPlan,
    build_gain_plan,
    validate_gain_plan,
    vocal_activity,
)
from backend.recordings.studio_voice import shape_voice
from backend.recordings.studio_spectrum import SpectrumPlan, measure_mix_spectrum, plan_presence_eq
from backend.recordings.studio_mix_audit import audit_mix


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
    space_reference: Path = field(init=False)
    plan: GainPlan = field(init=False)
    overlap: float = field(default=0.0, init=False)
    spectral: SpectrumPlan = field(init=False)

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
        with TemporaryDirectory(prefix=".master-", dir=self.target.parent) as directory:
            self.work = Path(directory)
            self._prepare_stems()
            self._scope_reference()
            self._recover_stems()
            bypass = self._analyze()
            if bypass is not None:
                return bypass
            self._balance_performance()
            pitch_correction = apply_reference_pitch(self)
            self.processing["pitchCorrection"] = pitch_correction
            self._shape_voice()
            self._write_balanced()
            self._finish_voice()
            self._deliver()
            self.processing["postMixAudit"] = audit_mix(
                self.balanced, self.backing, self.target, vocal_gain_db=self.voice_gain_db
            )
            self.processing["qualityControl"] = inspect_master(
                self.target,
                expected_frames=self.info.frames,
                expected_rate=self.info.samplerate,
                expected_channels=self.output_channels,
            )
            return self._balance_report()

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
            self.info.channels > 2
            and self.renderer._repeated_output_channels(self.performance_mix, self.cancel)
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
            "pipeline": "single-plan",
            "gainApplications": 0,
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

    def _recover_stems(self) -> None:
        if self.exact_stems or self.processing.get("referenceScope") not in [
            "continuous-performed-section",
            "performed-seek-sections",
        ]:
            return
        if any(
            a.playback_rate != 1 or a.key_shift != 0
            for a in parse_playback_adjustments(self.pitch_adjustments)
        ):
            return
        match = verified_backing_gain(self.performance_mix, self.original_instrumental, self.cancel)
        if match is None:
            return
        voice, music = self.work / "recovered-voice.wav", self.work / "recovered-backing.wav"
        self.renderer._mix(
            self.performance_mix,
            self.original_instrumental,
            f"[1:a]volume={match['gain']:.12f},asplit[b][music];"
            "[b]volume=-1[n];[0:a][n]amix=inputs=2:duration=first:normalize=0[out]",
            ["-c:a", "pcm_f32le", str(voice), "-map", "[music]", "-c:a", "pcm_f32le", str(music)],
            self.cancel,
        )
        self.user_vocal, self.backing, self.exact_stems = voice, music, True
        self.processing["stemRecovery"] = {"method": "verified-project-subtraction", **match}

    def _scope_reference(self) -> None:
        self.pitch_adjustments = self.adjustments
        self.space_reference = self.reference_vocal
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

    def _balance_performance(self) -> None:
        # Vocal dynamics use the full voice, not the changing spectrum of vowels.
        self.voice_db, self.backing_db, self.reference_db, self.original_db = (
            _profile(path, self.cancel)
            for path in (self.vocal, self.backing, self.reference_vocal, self.original_instrumental)
        )
        self.processing.update(
            balanceSource="performance-and-backing",
            levelingBand="broadband",
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
        self.gains = np.zeros_like(self.voice_db)
        self.reliable = vocal_activity(self.voice_db)

    def _shape_voice(self) -> None:
        evidence = measure_mix_spectrum(self.vocal, self.backing, self.cancel)
        self.overlap = evidence["overlap"]
        self.plan = build_gain_plan(
            self.renderer, self.vocal, self.backing, self.overlap, self.cancel
        )
        evidence["clarityBands"] = plan_presence_eq(
            self.vocal, self.backing, self.plan, self.cancel
        )
        evidence["bands"].extend(evidence["clarityBands"])
        self.vocal, evidence = shape_voice(
            self.renderer,
            self.vocal,
            self.backing,
            self.work / "shaped-voice.wav",
            self.cancel,
            plan=evidence,
        )
        self.processing["spectralPlan"] = evidence
        self.spectral = evidence
        self.overlap = evidence["overlap"]

    def _write_balanced(self) -> None:
        if self.spectral["bands"]:
            self.plan = build_gain_plan(
                self.renderer, self.vocal, self.backing, self.overlap, self.cancel
            )
        self.balanced = self.work / "planned-voice.wav"
        self.peak_bound = 0.0
        _write_gain_envelope(
            self.vocal, self.balanced, self.plan.times, self.plan.gains, self.cancel
        )
        self.processing["gainPlan"] = self.plan.report
        self.processing["gainApplications"] = 1
        self.processing["mixConstraints"] = validate_gain_plan(
            self.balanced, self.plan, self.cancel
        )
        self.gains = np.interp(self.times, self.plan.times, self.plan.gains)
        self.reliable = np.interp(self.times, self.plan.times, self.plan.active.astype(float)) > 0.5

    def _finish_voice(self) -> None:
        target = self.work / "spatial-voice.wav"
        effects = apply_reference_space(
            self.renderer,
            self.reference_vocal,
            self.user_vocal,
            self.balanced,
            target,
            self.cancel,
            full_reference=self.space_reference,
        )
        self.processing["referenceEffects"] = effects
        self.processing["space"] = effects["status"]
        if target.is_file():
            self.balanced = target
        self.processing["voiceOutputGainDb"] = 0.0

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
        self.user_vocal = self.work / "dry-stereo.wav"
        self.backing = self.work / "backing-stereo.wav"
        self.output_channels = 2
        source = self.work / "source-stereo.wav"
        self.renderer._mix(
            self.performance_mix,
            self.performance_mix,
            "[0:a]pan=stereo|c0=c0|c1=c1[out]",
            ["-c:a", "pcm_f32le", str(source)],
            self.cancel,
        )
        self.performance_mix = source

    def _prepare_voice(
        self, profile_tasks: list[Future[NDArray[np.float64]]]
    ) -> StudioMasterBalance | None:
        raw_profile = _profile(self.user_vocal, self.cancel)
        confident = raw_profile > max(-80.0, float(np.percentile(raw_profile, 90)) - 25)
        if np.count_nonzero(confident) * _PROFILE_SECONDS < 3:
            shutil.copyfile(self.performance_mix, self.target)
            profiles = [raw_profile, *(future.result() for future in profile_tasks)]
            voice_level, backing_level, reference_level, original_level = (
                float(np.median(levels)) for levels in profiles
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
        self._clean_voice()
        return None

    def _clean_voice(self) -> None:
        self.renderer._mix(
            self.user_vocal,
            self.backing,
            f"[0:a]highpass=f=60,apad,atrim=end_sample={self.info.frames}[out]",
            [
                "-ar",
                str(self.info.samplerate),
                "-ac",
                str(self.output_channels),
                "-c:a",
                "pcm_f32le",
                str(self.vocal),
            ],
            self.cancel,
        )

    def _map_reference_time(self) -> None:
        self.times = (np.arange(len(self.voice_db)) + 0.5) * _PROFILE_SECONDS
        self.source_times, self.timing_known, report = mapped_reference_times(
            self.times,
            self.adjustments,
            self.offset_result,
            self.reference_origin,
        )
        self.processing.update(report)
