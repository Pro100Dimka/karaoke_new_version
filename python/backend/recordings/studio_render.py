from __future__ import annotations
from backend.recordings.studio_delivery import MasterDelivery
from backend.recordings.studio_quality import inspect_master
from backend.recordings.studio_space import apply_reference_space, apply_fallback_space
from backend.recordings.studio_dynamics import _backing_curve, _protect_vocal_presence
from numpy.typing import NDArray
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import math
import shutil
import threading
from tempfile import TemporaryDirectory
import numpy as np
import soundfile as sf
from backend.analysis.scoring import parse_playback_adjustments, reference_audio_start
from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessResult
from backend.infrastructure.ffmpeg_audio import loudnorm_filter
from backend.recordings.studio_audio import (
    StudioMasterBalance,
    _PROFILE_SECONDS,
    _check_cancel,
    _profile,
)

from dataclasses import dataclass, field
from concurrent.futures import Future
from backend.recordings.studio_audio import MasterRenderer


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
    recording_analysis: Future[ProcessResult] | None = field(init=False)
    balanced: Path = field(init=False)
    peak_bound: float = field(init=False)
    voice_analysis: dict[str, object] = field(init=False)
    voice_gain_db: float = field(default=0, init=False)

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
            ThreadPoolExecutor(
                max_workers=1,
                thread_name_prefix="master-loudness",
            ) as loudness_pool,
        ):
            self.work = Path(directory)
            self._prepare_stems()
            bypass = self._analyze()
            if bypass is not None:
                return bypass
            bypass = self._match_reference()
            if bypass is not None:
                return bypass
            self._schedule_loudness(loudness_pool)
            # Preserve the accompaniment exactly as recorded; only the vocal is leveled.
            # Master delivery is peak-limited, not globally loudness-normalized.
            self._finish_voice()
            self._write_balanced()
            self._unmask()
            self._deliver()
            self.processing["qualityControl"] = inspect_master(
                self.target, expected_frames=self.info.frames,
                expected_rate=self.info.samplerate, expected_channels=self.output_channels,
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
            self.process_voice
            and self.exact_stems
            and self.info.channels > 2
            and self.renderer._repeated_output_channels(self.user_vocal, self.cancel)
            and self.renderer._repeated_output_channels(self.backing, self.cancel)
        ):
            self._stereo_stems()
        if not self.exact_stems:
            # A separator may put reverb into the accompaniment. Retain the residual of
            # the actual performance rather than replacing it with a reconstructed minus.
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
        # Independent file readers overlap voice processing; each owns its file handle.
        # Joining the bounded pool also keeps temporary files alive until all readers stop.
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="master-analysis") as pool:
            profile_tasks = [
                pool.submit(_profile, path, self.cancel)
                for path in (self.backing, self.reference_vocal, self.original_instrumental)
            ]
            alignment = (
                pool.submit(
                    self.renderer._reference_offset,
                    self.backing,
                    self.original_instrumental,
                    reference_audio_start(self.adjustments),
                    self.cancel,
                )
                if self.process_voice
                else None
            )
            self.vocal = self.user_vocal
            if self.process_voice:
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

    def _match_reference(self) -> StudioMasterBalance | None:
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
            phrase_smoothing=self.process_voice,
        )
        # Invalid timing metadata must not silently match the beginning of the song.
        if not self.timing_known:
            self.gains.fill(0)
            self.reliable.fill(False)
        if not self.timing_known or not self.reliable.any():
            # A missing reference timeline must not silently discard the entire
            # mastering chain. Keep unity vocal gain instead of guessing an
            # alignment; reference-space analysis is independent of timing.
            if not self.process_voice:
                shutil.copyfile(self.performance_mix, self.target)
                return StudioMasterBalance(
                    0,
                    float(np.median(self.voice_db)),
                    float(np.median(self.backing_db)),
                    float(np.median(self.reference_db)),
                    float(np.median(self.original_db)),
                    0,
                    processing={
                        "effectsApplied": False,
                        "outputChannels": self.info.channels,
                        "bypassReason": "unknown-timeline"
                        if not self.timing_known
                        else "no-reference-match",
                    },
                )
            self.processing["balanceFallback"] = (
                "unity-gain-unknown-timeline" if not self.timing_known
                else "unity-gain-unreliable-reference"
            )
            self.gains.fill(0)
            self.reliable.fill(False)
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

    def _schedule_loudness(self, loudness_pool: ThreadPoolExecutor) -> None:
        self.recording_analysis = (
            loudness_pool.submit(
                self.renderer._mix,
                self.performance_mix,
                self.performance_mix,
                "[0:a]" + loudnorm_filter(lra=11) + "[out]",
                ["-f", "null", "-"],
                self.cancel,
                quiet=False,
            )
            if self.match_recording_loudness and not self.process_voice
            else None
        )

    def _write_balanced(self) -> None:
        self.balanced = self.work / "balanced-voice.wav"
        self.peak_bound = 0.0
        with (
            sf.SoundFile(self.vocal) as source,
            sf.SoundFile(self.backing) as music,
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
                if not self.process_voice:
                    accompaniment = music.read(len(samples), always_2d=True)
                    if accompaniment.shape != adjusted.shape:
                        self.peak_bound = math.inf
                    else:
                        self.peak_bound = max(
                            self.peak_bound, float(np.max(np.abs(adjusted) + np.abs(accompaniment)))
                        )
                offset += len(samples)

    def _unmask(self) -> None:
        if self.process_voice:
            # Masking is an acoustic property, not a reference-timeline property.
            # Only use locally measured voice activity when alignment is uncertain.
            active = self.reliable if self.reliable.any() else self._voice_activity()
            unmasked = self.work / "unmasked-backing.wav"
            self.processing["spectralBalance"] = self.renderer._unmask_backing(
                self.backing,
                self.balanced,
                unmasked,
                active,
                self.cancel,
            )
            self.backing = unmasked

    def _voice_activity(self) -> NDArray[np.bool_]:
        levels = self.voice_db
        floor = float(np.percentile(levels, 20))
        threshold = max(-48.0, floor + 9.0, float(np.percentile(levels, 85)) - 22.0)
        active = levels > threshold
        self.processing["maskingActivityThresholdDbfs"] = threshold
        return active

    def _fallback_balance(self) -> None:
        """Bounded level match when original-vocal timing is unavailable.

        Do not normalize the instrumental or infer a singer's target from a
        different passage. A conservative vocal-to-backing level is sufficient.
        """
        voice = self.voice_db
        backing = self.backing_db
        active = self._voice_activity() & (backing > -70)
        if np.count_nonzero(active) < 12:
            self.processing["balanceFallback"] = "insufficient-activity-unity"
            return
        relative = float(np.median((voice - backing)[active]))
        # Conservative bounded correction; avoids boosting noise in quiet phrases.
        correction = float(np.clip(2.5 - relative, -4.0, 4.0))
        self.gains.fill(correction)
        self.processing["balanceFallback"] = "bounded-vocal-to-backing"
        self.processing["fallbackRelativeDb"] = relative
        self.processing["fallbackVocalGainDb"] = correction

    def _finish_voice(self) -> None:
        if not self.process_voice:
            return
        # Spatial matching needs no word-level alignment. It remains available
        # when reference loudness matching is too uncertain to be safe.
        spatial = self.work / "spatial-voice.wav"
        self.processing["referenceEffects"] = apply_reference_space(
            self.renderer,
            self.reference_vocal,
            self.user_vocal,
            self.vocal,
            spatial,
            self.cancel,
        )
        if not spatial.is_file():
            self.processing["fallbackEffects"] = apply_fallback_space(
                self.renderer, self.vocal, self.backing, spatial, self.cancel
            )
        if spatial.is_file():
            self.vocal = spatial
            self.processing["space"] = (
                "reference-matched" if self.processing["referenceEffects"]["status"] == "matched"
                else "backing-informed-room"
            )
            self.voice_db = _profile(self.vocal, self.cancel)
            if self.reliable.any():
                self.gains, self.reliable = self.renderer._balance_curve(
                    self.voice_db,
                    self.backing_db,
                    self.reference_db,
                    self.original_db,
                    phrase_smoothing=True,
                )
        if self.reliable.any():
            target = self.voice_db + self.gains
            self.processing["voiceBalanceTargetDb"] = float(
                np.median((target - self.backing_db)[self.reliable])
            )
            self.processing["voiceLeveling"] = "post-effects-reference-envelope"
        else:
            self._fallback_balance()
            self.processing["voiceLeveling"] = "bounded-song-level-fallback"
        self.gains, presence = _protect_vocal_presence(
            self.gains, self.voice_db, self.backing_db
        )
        self.processing["vocalPresence"] = presence
        self.processing["voiceLeveling"] += "-presence-protected"
        self.processing["voiceOutputGainDb"] = self.voice_gain_db
        self.processing["spaceAudible"] = spatial.is_file()
        self.processing["adaptive"] = {
            "referenceTimingTrusted": bool(self.timing_known),
            "referenceMatchedFraction": float(np.mean(self.reliable)),
            "equalization": "reference-informed-vocal-filters",
            "compression": "recording-dynamics-adaptive",
            "space": self.processing.get("referenceEffects", {}).get("status", "not-applied"),
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
            self.recording_analysis,
            self.peak_bound,
            self.reliable,
            self.processing,
            self.progress,
            voice_gain_db=self.voice_gain_db,
        ).run()

    def _stereo_stems(self) -> None:
        # Native device routing repeats the last source channel on additional outputs.
        # These are not surround channels; retain the original L/R pair for the master.
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
        confident = raw_profile > max(-45.0, float(np.percentile(raw_profile, 90)) - 25)
        if np.count_nonzero(confident) * _PROFILE_SECONDS < 3:
            shutil.copyfile(self.performance_mix, self.target)
            voice_level, backing_level, reference_level, original_level = (
                float(np.median(levels))
                for levels in (
                    raw_profile,
                    *(future.result() for future in profile_tasks),
                )
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
        self._process_voice(raw_profile)
        return None

    def _process_voice(self, raw_profile: NDArray[np.float64]) -> None:
        active = raw_profile[raw_profile > max(-60.0, float(np.max(raw_profile)) - 35)]
        if active.size == 0:
            raise DependencyError("StudioMasterSilentTrack", "No audible recorded voice")
        threshold = float(np.clip(10 ** (np.percentile(active, 65) / 20), 0.001, 1))
        ratio = float(
            np.clip(1 + (np.percentile(active, 90) - np.percentile(active, 20)) / 12, 1, 2.5)
        )
        filters, self.voice_analysis = self.renderer._voice_filters(
            self.user_vocal, raw_profile, self.cancel, self.reference_vocal
        )
        self.processing.update(
            compressorRatio=ratio,
            compressorThresholdDb=20 * math.log10(threshold),
            voiceAnalysis=self.voice_analysis,
            compressorMix=0.65,
        )
        filters.append(
            f"acompressor=threshold={threshold:.9f}:ratio={ratio:.6f}:attack=25:release=180:"
            "makeup=1:mix=0.65:link=maximum:detection=rms"
        )
        filters.extend(
            (
                f"aresample={self.info.samplerate}",
                "apad",
                f"atrim=end_sample={self.info.frames}",
            )
        )
        self.vocal = self.work / "processed-voice.wav"
        self.renderer._mix(
            self.user_vocal,
            self.backing,
            "[0:a]" + ",".join(filters) + "[out]",
            ["-ac", str(self.output_channels), "-c:a", "pcm_f32le", str(self.vocal)],
            self.cancel,
        )

    def _map_reference_time(self) -> None:
        self.times = (np.arange(len(self.voice_db)) + 0.5) * _PROFILE_SECONDS
        self.source_times = self.times.copy()
        parsed = parse_playback_adjustments(self.adjustments)
        for adjustment in parsed:
            selected = self.times >= adjustment.elapsed_seconds
            self.source_times[selected] = (
                adjustment.source_seconds
                + (self.times[selected] - adjustment.elapsed_seconds) * adjustment.playback_rate
            )
        self.timing_known = (
            bool(parsed) and parsed[0].elapsed_seconds == 0 and len(parsed) == len(self.adjustments)
        )
        if self.process_voice:
            assert self.offset_result is not None
            correction, confidence = self.offset_result
            self.source_times += correction
            self.timing_known = self.timing_known or (not self.adjustments and confidence >= 0.9)
            self.processing.update(
                referenceOffsetMs=correction * 1000,
                referenceCorrelation=confidence,
                synchronization=(
                    "backing-reference-confirmed"
                    if confidence >= 0.9
                    else "native-timeline-retained"
                ),
            )
