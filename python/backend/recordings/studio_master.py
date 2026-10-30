from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import math
import os
import shutil
import threading
from tempfile import TemporaryDirectory

import numpy as np
from numpy.typing import NDArray
from scipy.ndimage import median_filter, minimum_filter1d, uniform_filter1d
from scipy.signal import correlate, find_peaks, resample_poly
import soundfile as sf

from backend.analysis.scoring import parse_playback_adjustments, reference_audio_start
from backend.domain_errors import DependencyError, DomainError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.ffmpeg_audio import loudnorm_filter, parse_loudness
from backend.infrastructure.paths import ensure_within

_PROFILE_SECONDS = 0.1
_MAX_BOOST_DB = 9.0


@dataclass(frozen=True, slots=True)
class StudioMasterBalance:
    vocal_gain_db: float
    user_vocal_db: float
    performance_instrumental_db: float
    reference_vocal_db: float
    original_instrumental_db: float
    matched_fraction: float
    processing: Mapping[str, object] = field(default_factory=dict)

    def payload(self) -> dict[str, object]:
        return {
            "vocalGainDb": self.vocal_gain_db,
            "userVocalDb": self.user_vocal_db,
            "performanceInstrumentalDb": self.performance_instrumental_db,
            "referenceVocalDb": self.reference_vocal_db,
            "originalInstrumentalDb": self.original_instrumental_db,
            "levelMeasure": "rmsDbfs",
            "matchedFraction": self.matched_fraction,
            "maxBoostDb": _MAX_BOOST_DB,
            "processing": dict(self.processing),
        }


def recording_stems(path: Path, *, prefer_dry: bool = False) -> tuple[Path, Path] | None:
    dry = ensure_within(Path(str(path) + ".dry.wav"), path.parent)
    voice_suffix = ".dry.wav" if prefer_dry and dry.is_file() else ".vocal.wav"
    stems = tuple(ensure_within(Path(str(path) + suffix), path.parent)
                  for suffix in (voice_suffix, ".backing.wav"))
    if not all(stem.is_file() for stem in stems):
        return None
    info = sf.info(path)
    for stem in stems:
        other = sf.info(stem)
        if (other.frames, other.samplerate, other.channels) != (
            info.frames, info.samplerate, info.channels
        ):
            raise DependencyError("StudioMasterInvalidStems", "Recording stems are not synchronized")
    return stems[0], stems[1]


def _check_cancel(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise DomainError("ProcessCancelled", "Studio master was cancelled", 499)


def _profile(path: Path, cancel: threading.Event) -> NDArray[np.float64]:
    levels: list[float] = []
    with sf.SoundFile(path) as source:
        for samples in source.blocks(blocksize=round(source.samplerate * _PROFILE_SECONDS),
                                     dtype="float64", always_2d=True):
            _check_cancel(cancel)
            if not np.isfinite(samples).all():
                raise DependencyError("StudioMasterInvalidAudio", "Audio contains invalid samples")
            levels.append(10 * math.log10(max(1e-12, float(np.mean(samples * samples)))))
    if not levels:
        raise DependencyError("StudioMasterSilentTrack", "Recording contains no audio")
    return np.asarray(levels, dtype=np.float64)


class FfmpegStudioMasterRenderer:
    """Processes the recorded voice independently, retaining the accompaniment and timeline."""

    def __init__(self, runner: ProcessRunner, ffmpeg: str = "ffmpeg") -> None:
        self._runner = runner
        self._ffmpeg = ffmpeg

    def preserve_stems(self, path: Path) -> None:
        # Older native versions saved a paired backing, but no voice. Recover it once from
        # the untouched take; never subtract from an already balanced or limited replacement.
        backing = ensure_within(Path(str(path) + ".backing.wav"), path.parent)
        vocal = ensure_within(Path(str(path) + ".vocal.wav"), path.parent)
        if not backing.is_file() or vocal.is_file():
            return
        original = ensure_within(path.with_name(f"{path.stem}.original.wav"), path.parent)
        source = original if original.is_file() else path
        temporary = vocal.with_suffix(".publishing.wav")
        try:
            self._mix(source, backing,
                      "[1:a]volume=-1[b];[0:a][b]amix=inputs=2:duration=first:normalize=0[out]",
                      ["-c:a", "pcm_f32le", str(temporary)], threading.Event())
            os.replace(temporary, vocal)
        finally:
            temporary.unlink(missing_ok=True)

    def render(
        self,
        user_vocal: Path,
        performance_instrumental: Path,
        reference_vocal: Path,
        original_instrumental: Path,
        target: Path,
        cancel: threading.Event,
        *,
        performance_mix: Path,
        exact_stems: bool = False,
        process_voice: bool = False,
        adjustments: Sequence[Mapping[str, object]] = (),
        progress: Callable[[str, float, float], None] | None = None,
    ) -> StudioMasterBalance:
        info = sf.info(performance_mix)
        target.parent.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(target.parent).free < info.frames * info.channels * 20 + 64 * 1024**2:
            raise DependencyError("InsufficientDiskSpace", "Not enough space for recording stems and master")
        with TemporaryDirectory(prefix=".master-", dir=target.parent) as directory:
            work = Path(directory)
            backing = performance_instrumental
            output_channels = info.channels
            if process_voice and exact_stems and info.channels > 2 and all(
                self._repeated_output_channels(path, cancel) for path in (user_vocal, backing)
            ):
                # Native device routing repeats the last source channel on additional outputs.
                # These are not surround channels; retain the original L/R pair for the master.
                self._mix(user_vocal, backing,
                          "[0:a]pan=stereo|c0=c0|c1=c1[out];[1:a]pan=stereo|c0=c0|c1=c1[music]",
                          ["-c:a", "pcm_f32le", str(work / "dry-stereo.wav"),
                           "-map", "[music]", "-c:a", "pcm_f32le", str(work / "backing-stereo.wav")], cancel)
                user_vocal, backing = work / "dry-stereo.wav", work / "backing-stereo.wav"
                output_channels = 2
            if not exact_stems:
                # A separator may put reverb into the accompaniment. Retain the residual of
                # the actual performance rather than replacing it with a reconstructed minus.
                backing = work / "residual.wav"
                self._mix(performance_mix, user_vocal,
                          "[1:a]volume=-1[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[out]",
                          ["-ar", str(info.samplerate), "-c:a", "pcm_f32le", str(backing)], cancel)
            processing: dict[str, object] = {
                "voiceShiftMs": 0.0,
                "vocalSource": "dry" if process_voice else "existing-effects-preserved",
                "effectsApplied": process_voice,
                "outputChannels": output_channels,
            }
            # Independent file readers overlap voice processing; each owns its file handle.
            # Joining the bounded pool also keeps temporary files alive until all readers stop.
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="master-analysis") as pool:
                profile_tasks = [pool.submit(_profile, path, cancel)
                            for path in (backing, reference_vocal, original_instrumental)]
                alignment = (pool.submit(self._reference_offset, backing, original_instrumental,
                                         reference_audio_start(adjustments), cancel)
                             if process_voice else None)
                vocal = user_vocal
                if process_voice:
                    raw_profile = _profile(user_vocal, cancel)
                    confident = raw_profile > max(-45.0, float(np.percentile(raw_profile, 90)) - 25)
                    if np.count_nonzero(confident) * _PROFILE_SECONDS < 3:
                        shutil.copyfile(performance_mix, target)
                        voice_level, backing_level, reference_level, original_level = (
                            float(np.median(levels)) for levels in
                            (raw_profile, *(future.result() for future in profile_tasks))
                        )
                        return StudioMasterBalance(0, voice_level, backing_level, reference_level,
                                                   original_level, 0, processing={
                            "effectsApplied": False, "bypassReason": "insufficient-vocal-evidence",
                            "outputChannels": info.channels,
                        })
                    active = raw_profile[raw_profile > max(-60.0, float(np.max(raw_profile)) - 35)]
                    if active.size == 0:
                        raise DependencyError("StudioMasterSilentTrack", "No audible recorded voice")
                    threshold = float(np.clip(10 ** (np.percentile(active, 65) / 20), 0.001, 1))
                    ratio = float(np.clip(1 + (np.percentile(active, 90) - np.percentile(active, 20)) / 12,
                                          1, 2.5))
                    filters, voice_analysis = self._voice_filters(user_vocal, raw_profile, cancel)
                    processing.update(compressorRatio=ratio, compressorThresholdDb=20 * math.log10(threshold),
                                      voiceAnalysis=voice_analysis, compressorMix=0.65)
                    filters.append(
                        f"acompressor=threshold={threshold:.9f}:ratio={ratio:.6f}:attack=25:release=180:"
                        "makeup=1:mix=0.65:link=maximum:detection=rms"
                    )
                    filters.extend((f"aresample={info.samplerate}", "apad", f"atrim=end_sample={info.frames}"))
                    vocal = work / "processed-voice.wav"
                    self._mix(user_vocal, backing, "[0:a]" + ",".join(filters) + "[out]",
                              ["-ac", str(output_channels), "-c:a", "pcm_f32le", str(vocal)], cancel)
                if progress:
                    progress("AnalyzingBalance", 0.3, 0.65)
                voice_db = _profile(vocal, cancel)
                backing_db, reference_db, original_db = (future.result() for future in profile_tasks)
                offset_result = alignment.result() if alignment is not None else None
            times = (np.arange(len(voice_db)) + 0.5) * _PROFILE_SECONDS
            source_times = times.copy()
            parsed = parse_playback_adjustments(adjustments)
            for adjustment in parsed:
                selected = times >= adjustment.elapsed_seconds
                source_times[selected] = adjustment.source_seconds + (
                    times[selected] - adjustment.elapsed_seconds
                ) * adjustment.playback_rate
            timing_known = bool(parsed) and parsed[0].elapsed_seconds == 0 and len(parsed) == len(adjustments)
            if process_voice:
                assert offset_result is not None
                correction, confidence = offset_result
                source_times += correction
                timing_known = timing_known or (not adjustments and confidence >= 0.9)
                processing.update(referenceOffsetMs=correction * 1000,
                                  referenceCorrelation=confidence,
                                  synchronization=("backing-reference-confirmed" if confidence >= 0.9
                                                   else "native-timeline-retained"))
            profiles = []
            for levels, positions in ((backing_db, times), (reference_db, source_times),
                                      (original_db, source_times)):
                axis = (np.arange(len(levels)) + 0.5) * _PROFILE_SECONDS
                profiles.append(np.interp(positions, axis, levels, left=-120, right=-120))
            backing_db, reference_db, original_db = profiles
            gains, reliable = self._balance_curve(voice_db, backing_db, reference_db, original_db,
                                                   phrase_smoothing=process_voice)
            # Invalid timing metadata must not silently match the beginning of the song.
            if not timing_known:
                gains.fill(0)
                reliable.fill(False)
            if not timing_known or (not process_voice and not reliable.any()):
                shutil.copyfile(performance_mix, target)
                return StudioMasterBalance(
                    0, float(np.median(voice_db)), float(np.median(backing_db)),
                    float(np.median(reference_db)), float(np.median(original_db)), 0,
                    processing={"effectsApplied": False, "outputChannels": info.channels,
                                "bypassReason": "unknown-timeline" if not timing_known else "no-reference-match"},
                )
            if process_voice:
                # Support sustained dips within a phrase, not pauses, consonant attacks or
                # intentional softness also present in the reference. Preserve the broad curve.
                floor = max(-50.0, float(np.percentile(voice_db, 10)) + 15)
                supported = reliable & (voice_db > floor)
                supported = minimum_filter1d(supported.astype(float), size=5, mode="constant")
                local_level = median_filter(voice_db, size=5, mode="nearest")
                phrase_level = median_filter(voice_db, size=31, mode="nearest")
                deficit = (reference_db - original_db) - (voice_db + gains - backing_db)
                detail = np.minimum(np.clip((phrase_level - local_level - 6) * 0.25, 0, 1.5),
                                    np.clip((deficit - 3) * 0.25, 0, 1.5)) * supported
                if np.count_nonzero(supported) < 30:
                    detail.fill(0)
                detail = uniform_filter1d(detail, size=5, mode="constant") * supported
                detail = np.minimum(detail, np.maximum(0, _MAX_BOOST_DB - gains))
                gains += detail
                processing["phraseDetail"] = {
                    "maxBoostDb": float(np.max(detail)), "limitDb": 1.5,
                    "affectedSeconds": float(np.count_nonzero(detail > 0.1) * _PROFILE_SECONDS),
                    "method": "supported-intraphrase-dips",
                }
            balanced = work / "balanced-voice.wav"
            peak_bound = 0.0
            with sf.SoundFile(vocal) as source, sf.SoundFile(backing) as music, sf.SoundFile(
                balanced, "w", samplerate=source.samplerate, channels=source.channels, subtype="FLOAT"
            ) as output:
                offset = 0
                for samples in source.blocks(blocksize=65536, dtype="float32", always_2d=True):
                    _check_cancel(cancel)
                    positions = (offset + np.arange(len(samples))) / source.samplerate
                    gain = np.power(10.0, np.interp(positions, times, gains) / 20)
                    adjusted = samples * gain[:, None]
                    output.write(adjusted)
                    if not process_voice:
                        accompaniment = music.read(len(samples), always_2d=True)
                        if accompaniment.shape != adjusted.shape:
                            peak_bound = math.inf
                        else:
                            peak_bound = max(peak_bound, float(np.max(np.abs(adjusted) + np.abs(accompaniment))))
                    offset += len(samples)
            if process_voice and reliable.any():
                unmasked = work / "unmasked-backing.wav"
                processing["spectralBalance"] = self._unmask_backing(
                    backing, balanced, unmasked, reliable, cancel,
                )
                backing = unmasked
            if process_voice and reliable.any() and voice_analysis["spaceEligible"]:
                spatial = work / "spatial-voice.wav"
                threshold = float(np.clip(10 ** (np.median((voice_db + gains)[reliable]) / 20),
                                          0.001, 1))
                # Share a quiet reflection bed; bound the music send relative to the voice.
                music_send = float(np.clip(0.1 * 10 ** (
                    (np.median((voice_db + gains)[reliable]) - np.median(backing_db[reliable])) / 20
                ), 0, 0.25))
                # Direct paths stay undelayed; only the reflection tail is trimmed.
                self._mix(balanced, backing,
                          "[0:a]asplit=3[dry][vsend][control];"
                          f"[1:a]volume={music_send:.9f}[msend];"
                          "[vsend][msend]amix=inputs=2:duration=first:normalize=0[send];"
                          "[send]highpass=f=180,lowpass=f=6000,adelay=8:all=1,"
                          "aecho=1:0.5:31|47|71|101:0.3|0.25|0.2|0.15,"
                          "aecho=1:0.5:43|79|137:0.25|0.2|0.15,volume=0.12[wet];"
                          f"[wet][control]sidechaincompress=threshold={threshold:.9f}:"
                          "ratio=4:attack=8:release=240:makeup=1:link=maximum[room];"
                          "[dry][room]amix=inputs=2:duration=first:normalize=0,"
                          f"apad,atrim=end_sample={info.frames}[out]",
                          ["-c:a", "pcm_f32le", str(spatial)], cancel)
                balanced = spatial
                processing["space"] = "shared-ducked-short-reflections"
                processing["spaceMusicSend"] = music_send
            if progress:
                progress("AnalyzingBalance", 1.0, 0.78)
            graph = "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
            # A unity-gain original needs no preliminary loudness scan if its samples cannot
            # clip. Always meter the encoded file; intersample overshoots still trigger attenuation.
            unity_candidate = not process_voice and peak_bound < 0.95
            measured = None
            ceiling = -1.0 if process_voice else -3.0
            target_lufs, gain = 0.0, 0.0
            if not unity_candidate:
                analysis = self._mix(backing, balanced, graph + loudnorm_filter(lra=11) + "[out]",
                                     ["-f", "null", "-"], cancel, quiet=False)
                measured = parse_loudness(analysis.stderr)
                if measured is None or not all(math.isfinite(value) for value in measured.values()):
                    raise DependencyError("StudioMasterFailed", "Studio master loudness analysis failed")
                target_lufs = -14.0 if process_voice else measured["input_i"]
                gain = min(target_lufs - measured["input_i"], ceiling - 0.05 - measured["input_tp"])
                if process_voice and np.count_nonzero(reliable) * _PROFILE_SECONDS < 3:
                    gain = min(gain, 0.0)
            if progress:
                progress("AnalyzingBalance", 1.0, 0.85)
            final_levels = None
            for attempt in range(2):
                self._mix(backing, balanced, graph + f"volume={gain:.9f}dB[out]",
                          ["-ar", str(info.samplerate), "-ac", str(output_channels),
                           "-c:a", "pcm_s24le", str(target)], cancel)
                verification = self._mix(
                    target, target, "[0:a]" + loudnorm_filter(lra=11) + "[out]",
                    ["-f", "null", "-"], cancel, quiet=False,
                )
                final_levels = parse_loudness(verification.stderr)
                if final_levels is None or not all(math.isfinite(v) for v in final_levels.values()):
                    raise DependencyError("StudioMasterFailed", "Final master loudness could not be verified")
                if measured is None:
                    measured = final_levels
                    target_lufs = measured["input_i"]
                peak_limit = ceiling - 0.05 if unity_candidate and attempt == 0 else ceiling
                if final_levels["input_tp"] <= peak_limit and final_levels["input_i"] <= target_lufs + 0.2:
                    break
                if attempt == 1:
                    raise DependencyError("StudioMasterFailed", "Final master exceeds its loudness or peak ceiling")
                # Re-render from float stems, never repeatedly quantize the published result.
                gain += min(0.0, ceiling - 0.05 - final_levels["input_tp"],
                            target_lufs - final_levels["input_i"])
            if final_levels is not None and measured is not None:
                processing["delivery"] = {
                    "method": "measured-linear-gain", "gainDb": gain,
                    "targetLufs": target_lufs, "truePeakCeilingDbtp": ceiling,
                    "integratedLufs": final_levels["input_i"],
                    "truePeakDbtp": final_levels["input_tp"],
                    "loudnessRangeLu": final_levels["input_lra"],
                    "mixLoudnessRangeLu": measured["input_lra"],
                    "verified": True,
                }
            output_info = sf.info(target)
            if (output_info.frames, output_info.samplerate, output_info.channels) != (
                info.frames, info.samplerate, output_channels
            ):
                raise DependencyError("StudioMasterInvalidAudio", "Master changed the recording length")
            voice_level, backing_level, reference_level, original_level = (
                float(np.median(values[reliable])) if reliable.any() else float(np.median(values))
                for values in (voice_db, backing_db, reference_db, original_db)
            )
            return StudioMasterBalance(
                float(np.median(gains[reliable])) if reliable.any() else 0,
                voice_level, backing_level, reference_level, original_level, float(np.mean(reliable)),
                processing,
            )

    @staticmethod
    def _balance_curve(
        voice: NDArray[np.float64], backing: NDArray[np.float64],
        reference: NDArray[np.float64], original: NDArray[np.float64],
        *, phrase_smoothing: bool = False,
    ) -> tuple[NDArray[np.float64], NDArray[np.bool_]]:
        # Require both singers and both accompaniments. Do not normalize rests or a noise floor
        # to a professional singer. This is an energy guard, not a claim of speech recognition.
        floor = max(-55.0, float(np.percentile(voice, 20)) + 10.0)
        upper = float(np.percentile(voice, 80))
        if floor >= upper:
            floor = max(-55.0, upper - 10.0)
        reliable = ((voice > floor) & (reference > max(-55.0, float(np.max(reference)) - 30))
                    & (backing > -60) & (original > -60))
        desired = np.minimum((reference - original) - (voice - backing), _MAX_BOOST_DB)
        if not reliable.any():
            return np.zeros_like(voice), reliable
        # Bound boosts, not attenuation: a loud singer may need more than 9 dB of reduction.
        # Carry the measured balance through gaps instead of restoring full vocal gain there.
        positions = np.arange(len(voice))
        gains = np.interp(positions, positions[reliable], desired[reliable])
        # A two-second median rejects syllable transients; a one-second ramp avoids gain steps.
        gains = uniform_filter1d(median_filter(gains, size=21, mode="nearest"),
                                 size=11, mode="nearest")
        # Never boost a pause just because adjacent words were quiet. Attenuation may persist.
        if phrase_smoothing:
            # Ramp boosts down before rests. Bound gain velocity to 3 dB/s in both directions.
            ceiling = uniform_filter1d(minimum_filter1d(reliable.astype(float), size=11), size=9)
            gains = np.minimum(gains, ceiling * _MAX_BOOST_DB)
            for indices in (range(1, len(gains)), range(len(gains) - 2, -1, -1)):
                step = indices.step
                for index in indices:
                    gains[index] = min(gains[index], gains[index - step] + 0.3)
        else:
            gains = np.minimum(gains, np.where(reliable, _MAX_BOOST_DB, 0.0))
        return gains, reliable

    @staticmethod
    def _repeated_output_channels(path: Path, cancel: threading.Event) -> bool:
        with sf.SoundFile(path) as source:
            for samples in source.blocks(blocksize=65536, always_2d=True):
                _check_cancel(cancel)
                if not np.all(samples[:, 2:] == samples[:, 1:2]):
                    return False
        return True

    @staticmethod
    def _unmask_backing(
        backing: Path, voice: Path, target: Path, active: NDArray[np.bool_],
        cancel: threading.Event,
    ) -> dict[str, object]:
        # Weighted overlap-add retains the sample timeline and bounds memory independently of
        # song length. One smooth spectral gain is shared by all channels to retain stereo cues.
        size, hop = 2048, 512
        window = np.hanning(size)
        centers = np.asarray([250., 500., 1000., 2000., 4000.])
        cut = np.zeros(len(centers))
        totals = np.zeros(len(centers))
        maximum = np.zeros(len(centers))
        windows = affected = 0
        with sf.SoundFile(backing) as music, sf.SoundFile(voice) as singer, sf.SoundFile(
            target, "w", samplerate=music.samplerate, channels=music.channels, subtype="FLOAT",
        ) as output:
            frequencies = np.fft.rfftfreq(size, 1 / music.samplerate)
            bands = [(frequencies >= center / np.sqrt(2)) &
                     (frequencies < center * np.sqrt(2)) for center in centers]
            log_axis = np.log(np.r_[150., centers, 6500.])
            accumulation = np.zeros((size, music.channels))
            weight = np.zeros(size)
            frequency_axis = np.log(np.maximum(frequencies, 1))
            attack = np.exp(-hop / (music.samplerate * 0.08))
            release = np.exp(-hop / (music.samplerate * 0.25))
            # Batch FFTs and disk IO, retaining the original sequential envelope and overlap-add.
            for batch_start in range(-size + hop, music.frames, 16 * hop):
                _check_cancel(cancel)
                starts = np.arange(batch_start, min(music.frames, batch_start + 16 * hop), hop)
                count = len(starts)
                spectra = []
                for source in (music, singer):
                    samples = np.zeros((size + (count - 1) * hop, source.channels))
                    begin, end = max(0, batch_start), min(source.frames, batch_start + len(samples))
                    if end > begin:
                        source.seek(begin)
                        samples[begin - batch_start:end - batch_start] = source.read(end - begin, always_2d=True)
                    frames = np.lib.stride_tricks.sliding_window_view(samples, size, axis=0)[::hop]
                    frames = np.moveaxis(frames, -1, 1)
                    spectra.append(np.fft.rfft(frames * window[None, :, None], axis=1))
                music_power, voice_power = (np.mean(abs(value) ** 2, axis=2) for value in spectra)
                total_voice = np.maximum(np.sum(voice_power, axis=1), 1e-20)
                desired = np.zeros((count, len(centers)))
                positions = (starts + size / 2) / music.samplerate
                indices = (positions / _PROFILE_SECONDS).astype(int)
                eligible = (positions >= 0) & (indices >= 0) & (indices < len(active))
                eligible[eligible] &= active[indices[eligible]]
                for band, selected in enumerate(bands):
                    vocal = np.sum(voice_power[:, selected], axis=1)
                    instrumental = np.sum(music_power[:, selected], axis=1)
                    overlap = 10 * np.log10(np.maximum(instrumental, 1e-20) / np.maximum(vocal, 1e-20))
                    desired[:, band] = np.where(eligible & (vocal / total_voice >= 0.01),
                                               np.clip((overlap - 3) * 0.2, 0, 1.5), 0)
                for index in range(count):
                    coefficient = np.where(desired[index] > cut, attack, release)
                    cut = coefficient * cut + (1 - coefficient) * desired[index]
                    attenuation = np.interp(frequency_axis, log_axis, np.r_[0., cut, 0.], left=0, right=0)
                    spectra[0][index] *= np.power(10., -attenuation[:, None] / 20)
                    if starts[index] >= 0:
                        windows += 1
                        affected += int(np.max(cut) > 0.1)
                        totals += cut
                        maximum = np.maximum(maximum, cut)
                reconstructed = np.fft.irfft(spectra[0], n=size, axis=1) * window[None, :, None]
                pending = np.empty((count * hop, music.channels))
                pending_frames = 0
                for index, start in enumerate(starts):
                    accumulation += reconstructed[index]
                    weight += window * window
                    if start >= 0:
                        length = min(hop, music.frames - start)
                        pending[pending_frames:pending_frames + length] = (
                            accumulation[:length] / np.maximum(weight[:length, None], 1e-12))
                        pending_frames += length
                    accumulation[:-hop] = accumulation[hop:]
                    accumulation[-hop:] = 0
                    weight[:-hop] = weight[hop:]
                    weight[-hop:] = 0
                if pending_frames:
                    output.write(pending[:pending_frames])
        return {"centersHz": centers.tolist(), "meanReductionDb": (totals / max(windows, 1)).tolist(),
                "maxReductionDb": maximum.tolist(), "affectedFraction": affected / max(windows, 1),
                "limitDb": 1.5, "attackMs": 80, "releaseMs": 250}

    @staticmethod
    def _voice_filters(
        path: Path, levels: NDArray[np.float64], cancel: threading.Event,
    ) -> tuple[list[str], dict[str, object]]:
        filters = ["highpass=f=60"]
        noise_floor = float(np.percentile(levels, 10))
        quiet_seconds = float(np.count_nonzero(levels <= noise_floor + 3) * _PROFILE_SECONDS)
        contrast = float(np.percentile(levels, 80)) - noise_floor
        noise_detected = -75 < noise_floor < -35 and contrast >= 18 and quiet_seconds >= 1
        if noise_detected:
            # A soft expander, never a hard mute: keep breaths and word tails recoverable.
            threshold = 10 ** ((noise_floor + 6) / 20)
            filters.append(f"agate=threshold={threshold:.9f}:range=0.5:ratio=1.5:"
                           "attack=5:release=250:makeup=1:link=maximum:detection=rms")
        spectral_frames, ratios = [], []
        floor = max(-55.0, float(np.max(levels)) - 30, noise_floor + 10)
        with sf.SoundFile(path) as source:
            centers = np.geomspace(150, min(10000, source.samplerate * 0.45), 96)
            size = round(source.samplerate * _PROFILE_SECONDS)
            window = np.hanning(size)[:, None]
            frequencies = np.fft.rfftfreq(size, 1 / source.samplerate)
            band_bins = [(frequencies >= center / 1.04) & (frequencies <= center * 1.04)
                         for center in centers]
            presence_bins = (frequencies >= 500) & (frequencies < 4000)
            treble_bins = (frequencies >= 4000) & (frequencies < 10000)
            for index, samples in enumerate(source.blocks(blocksize=size, always_2d=True)):
                _check_cancel(cancel)
                if levels[index] <= floor or len(samples) < size:
                    continue
                spectrum = np.mean(abs(np.fft.rfft(samples * window,
                                                 axis=0)) ** 2, axis=1)
                # Band averages suppress isolated FFT-bin/harmonic peaks before resonance selection.
                envelope = np.asarray([
                    float(np.mean(spectrum[selected])) for selected in band_bins
                ])
                spectral_frames.append(10 * np.log10(np.maximum(envelope, 1e-20)))
                presence = float(np.sum(spectrum[presence_bins]))
                treble = float(np.sum(spectrum[treble_bins]))
                ratios.append(10 * math.log10(max(treble, 1e-20) / max(presence, 1e-20)))
        resonances: list[float] = []
        intensity = 0.0
        # Sparse/uncertain evidence must not turn into a blanket EQ or de-esser preset.
        if len(spectral_frames) >= 20:
            spectra = np.asarray(spectral_frames)
            prominence = spectra - median_filter(spectra, size=(1, 9), mode="nearest")
            median_prominence = np.median(prominence, axis=0)
            peaks, _ = find_peaks(median_prominence, height=6, distance=6)
            candidates = [int(i) for i in peaks if 900 <= centers[i] <= 6500
                          and float(np.mean(prominence[:, i] > 6)) >= 0.35]
            candidates.sort(key=lambda i: float(median_prominence[i]), reverse=True)
            resonances = [float(centers[i]) for i in candidates[:2]]
            for frequency in resonances:
                # Small dynamic cuts protect natural vowel/formant differences between singers.
                filters.append(f"adynamicequalizer=dfrequency={frequency:.3f}:dqfactor=6:"
                               f"tfrequency={frequency:.3f}:tqfactor=6:mode=cutabove:"
                               "auto=adaptive:threshold=0.01:range=1:ratio=0.5:attack=20:release=180")
            median_ratio, high_ratio = np.percentile(ratios, [50, 95])
            if high_ratio > -10:
                intensity = float(np.clip((high_ratio - median_ratio - 6) / 36, 0, 0.2))
        if intensity > 0:
            filters.append(f"deesser=i={intensity:.6f}:m=0.25:f=0.5")
        # Quiet gaps can reveal lingering room energy, but do not identify its cause.
        # With too few gaps, avoid adding an unverified reflection bed.
        upper = float(np.percentile(levels, 80))
        ends = np.flatnonzero((levels[:-1] > upper - 15) & (levels[1:] <= upper - 15)) + 1
        tails = [float(np.max(levels[i + 2:i + 5]) - np.median(levels[i - 5:i]))
                 for i in ends if i >= 5 and i + 5 < len(levels)
                 and float(np.max(levels[i:i + 5])) < upper - 15]
        space_eligible = len(tails) >= 3 and float(np.median(tails)) < -18
        return filters, {
            "spaceEligible": space_eligible, "spaceGapCount": len(tails),
            "spaceTailRelativeDb": float(np.median(tails)) if tails else None,
            "noiseFloorDbfs": noise_floor, "pauseExpansionApplied": noise_detected,
            "pauseExpansionLimitDb": 6.0206 if noise_detected else 0,
            "activeAnalysisSeconds": len(spectral_frames) * _PROFILE_SECONDS,
            "resonanceFrequenciesHz": resonances, "deesserIntensity": intensity,
            "method": "conservative-signal-dependent",
        }

    @staticmethod
    def _reference_offset(
        backing: Path, original: Path, origin: float | None, cancel: threading.Event,
    ) -> tuple[float, float]:
        # Match the SAME accompaniment, never two different singers. Tempo/key/seek changes
        # disable PCM matching; their explicit timeline mapping remains authoritative.
        if origin is None:
            return 0.0, 0.0
        duration = sf.info(backing).duration
        if duration < 8:
            return 0.0, 0.0
        rate = 4000
        margin = 0.25
        offsets, scores = [], []

        def read(source: sf.SoundFile, start: float, seconds: float) -> NDArray[np.float64]:
            source.seek(round(start * source.samplerate))
            samples = source.read(round(seconds * source.samplerate), always_2d=True).mean(axis=1)
            divisor = math.gcd(source.samplerate, rate)
            return np.asarray(resample_poly(samples, rate // divisor, source.samplerate // divisor),
                              dtype=np.float64)

        with sf.SoundFile(backing) as take, sf.SoundFile(original) as reference:
            for position in np.linspace(1, duration - 3, 3):
                _check_cancel(cancel)
                start = origin + position - margin
                if start < 0 or start + 2 + 2 * margin > reference.frames / reference.samplerate:
                    continue
                actual = read(take, float(position), 2)
                expected = read(reference, float(start), 2 + 2 * margin)
                actual -= actual.mean()
                power = float(actual @ actual)
                if power < 1e-8 or len(expected) < len(actual):
                    continue
                count = len(actual)
                sums = np.r_[0.0, np.cumsum(expected)]
                squares = np.r_[0.0, np.cumsum(expected * expected)]
                variance = squares[count:] - squares[:-count] - (sums[count:] - sums[:-count]) ** 2 / count
                similarity = correlate(expected, actual, mode="valid", method="fft") / np.sqrt(
                    np.maximum(variance * power, 1e-20))
                peak = int(np.argmax(similarity))
                score = float(similarity[peak])
                if score < 0.9 or peak in (0, len(similarity) - 1):
                    continue
                competing = similarity.copy()
                competing[max(0, peak - 200):peak + 201] = -1
                if score - float(np.max(competing)) < 0.05:
                    continue
                offsets.append(peak / rate - margin)
                scores.append(score)
        if len(offsets) < 3 or np.ptp(offsets) > 0.002:
            return 0.0, 0.0
        return float(np.median(offsets)), min(scores)

    def _mix(
        self, first: Path, second: Path, filter_graph: str, output: list[str],
        cancel: threading.Event, *, quiet: bool = True,
    ) -> ProcessResult:
        result = self._runner.run(
            [self._ffmpeg, "-hide_banner", "-nostats", "-v", "error" if quiet else "info", "-y",
             "-i", str(first), "-i", str(second), "-filter_complex_threads", "1",
             "-filter_complex", filter_graph, "-map", "[out]", *output],
            timeout_seconds=900, cancel=cancel,
        )
        if result.exit_code != 0:
            raise DependencyError("StudioMasterFailed", "Studio master audio processing failed")
        return result
