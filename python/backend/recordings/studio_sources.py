"""Prepare immutable recording sources on one sample-exact performed timeline."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
import threading

import soundfile as sf

from backend.analysis.domain import PlaybackAdjustment
from backend.analysis.scoring import parse_playback_adjustments
from backend.domain_errors import DependencyError
from backend.recordings.studio_adaptive_timing import shift_audio
from backend.recordings.studio_audio import MasterRenderer, _check_cancel
from backend.recordings.studio_reference import verified_backing_gain

IDENTITY_TIMELINE: tuple[Mapping[str, object], ...] = (
    {"elapsedSeconds": 0, "sourceSeconds": 0, "playbackRate": 1, "keyShift": 0},
)


@dataclass(frozen=True, slots=True)
class MasterSources:
    vocal: Path
    backing: Path
    reference_vocal: Path | None
    reference_backing: Path | None
    original_mix: Path | None
    frames: int
    rate: int
    channels: int
    report: dict[str, object]


def _timeline_points(
    adjustments: Sequence[Mapping[str, object]], duration: float
) -> tuple[tuple[PlaybackAdjustment, ...], list[float]]:
    points = parse_playback_adjustments(adjustments)
    ends = [point.elapsed_seconds for point in points[1:]] + [duration]
    if (
        duration <= 0
        or not points
        or len(points) != len(adjustments)
        or points[0].elapsed_seconds != 0
        or any(end <= point.elapsed_seconds for point, end in zip(points, ends))
    ):
        raise DependencyError("StudioMasterTimelineUnavailable", "Recording timeline is invalid")
    return points, ends


def _segment_filter(point: PlaybackAdjustment, end: float, index: int, rate: int) -> str:
    length = end - point.elapsed_seconds
    count = round(end * rate) - round(point.elapsed_seconds * rate)
    transform = (
        f"rubberband=tempo={point.playback_rate:.12f}:"
        f"pitch={2 ** (point.key_shift / 12):.12f}:channels=together:"
        "pitchq=consistency:transients=smooth,"
        if point.playback_rate != 1 or point.key_shift != 0
        else ""
    )
    return (
        f"[s{index}]atrim=start={point.source_seconds:.12f}:"
        f"duration={length * point.playback_rate:.12f},asetpts=PTS-STARTPTS,"
        f"{transform}aresample={rate},apad,atrim=end_sample={count}[p{index}]"
    )


def render_timeline(
    renderer: MasterRenderer,
    source: Path,
    target: Path,
    cancel: threading.Event,
    adjustments: Sequence[Mapping[str, object]],
    *,
    frames: int,
    rate: int,
    channels: int,
) -> float:
    """Map playback edits once; round absolute boundaries rather than each duration."""
    _check_cancel(cancel)
    points, ends = _timeline_points(adjustments, frames / rate)
    available = float(sf.info(source).duration)
    covered = sum(
        min(
            end - point.elapsed_seconds,
            max(0, available - point.source_seconds) / point.playback_rate,
        )
        for point, end in zip(points, ends)
    )
    graph = [f"[0:a]asplit={len(points)}" + "".join(f"[s{i}]" for i in range(len(points)))]
    graph.extend(
        _segment_filter(point, end, i, rate) for i, (point, end) in enumerate(zip(points, ends))
    )
    graph.append(
        "".join(f"[p{i}]" for i in range(len(points)))
        + f"concat=n={len(points)}:v=0:a=1,apad,atrim=end_sample={frames}[out]"
    )
    output = ["-ac", str(channels), "-ar", str(rate), "-c:a", "pcm_f32le", str(target)]
    renderer._mix(source, source, ";".join(graph), output, cancel)
    info = sf.info(target)
    if (info.frames, info.samplerate, info.channels) != (frames, rate, channels):
        raise DependencyError("StudioMasterInvalidAudio", "Reference timeline changed format")
    return min(1.0, covered / (frames / rate))


@dataclass(slots=True)
class _SourcePreparation:
    renderer: MasterRenderer
    vocal: Path
    recorded_backing: Path
    reference_vocal: Path
    original_backing: Path
    mix: Path
    work: Path
    cancel: threading.Event
    adjustments: Sequence[Mapping[str, object]]
    exact_stems: bool
    original_mix: Path | None
    info: sf._SoundFileInfo = field(init=False)
    channels: int = field(init=False)
    project: Path = field(init=False)
    reference: Path = field(init=False)
    trusted: bool = field(init=False)
    reference_shift: int = field(default=0, init=False)
    report: dict[str, object] = field(default_factory=dict, init=False)

    def run(self) -> MasterSources:
        self._validate_stems()
        self._normalize_channels()
        self._map_reference()
        self._recover_stems()
        original = self._optional_original()
        self.report["backingSource"] = (
            "project-timeline-without-monitor-gains" if self.trusted else "recorded-accompaniment"
        )
        return MasterSources(
            self.vocal,
            self.project if self.trusted else self.recorded_backing,
            self.reference if self.trusted else None,
            self.project if self.trusted else None,
            original,
            self.info.frames,
            self.info.samplerate,
            self.channels,
            self.report,
        )

    def _validate_stems(self) -> None:
        self.info = sf.info(self.mix)
        self.channels = self.info.channels
        for path in (self.vocal, self.recorded_backing):
            stem = sf.info(path)
            if (stem.frames, stem.samplerate) != (self.info.frames, self.info.samplerate):
                raise DependencyError(
                    "StudioMasterStemMismatch", "Recording stems are not synchronized"
                )
            if stem.channels != self.channels:
                raise DependencyError("StudioMasterStemMismatch", "Recording stem channels differ")

    def _normalize_channels(self) -> None:
        sources = (self.mix, self.vocal, self.recorded_backing)
        if self.channels > 2 and all(
            self.renderer._repeated_output_channels(path, self.cancel) for path in sources
        ):
            self.channels = 2
            converted = []
            for index, source in enumerate(sources):
                target = self.work / f"stereo-{index}.wav"
                self.renderer._mix(
                    source,
                    source,
                    "[0:a]pan=stereo|c0=c0|c1=c1[out]",
                    ["-c:a", "pcm_f32le", str(target)],
                    self.cancel,
                )
                converted.append(target)
            self.mix, self.vocal, self.recorded_backing = converted
        self.report.update(outputChannels=self.channels, sourceFrames=self.info.frames)

    def _timeline(self, source: Path, target: Path) -> float:
        return render_timeline(
            self.renderer,
            source,
            target,
            self.cancel,
            self.adjustments or IDENTITY_TIMELINE,
            frames=self.info.frames,
            rate=self.info.samplerate,
            channels=self.channels,
        )

    def _map_reference(self) -> None:
        self.project, self.reference = (
            self.work / "project-timeline.wav",
            self.work / "reference-timeline.wav",
        )
        coverage = min(
            self._timeline(self.original_backing, self.project),
            self._timeline(self.reference_vocal, self.reference),
        )
        correction, confidence = self.renderer._reference_offset(
            self.recorded_backing, self.project, 0.0, self.cancel
        )
        # Native timestamps are authoritative; legacy takes need same-backing evidence.
        self.trusted = (bool(self.adjustments) or confidence >= 0.9) and coverage >= 0.999
        self.report.update(
            referenceCoverage=coverage,
            referenceCorrelation=confidence,
            referenceOffsetMs=correction * 1000,
            synchronization="native-playback-timeline"
            if self.adjustments
            else "backing-reference-confirmed"
            if self.trusted
            else "unconfirmed-timeline",
            referenceScope="performed-recording-only" if self.trusted else "unconfirmed-timeline",
        )
        if self.trusted and confidence >= 0.9 and abs(correction) > 0.0001:
            # Align the SAME accompaniment, never sample-correlate different singers.
            self.reference_shift = -round(correction * self.info.samplerate)
            self._align_reference(self.project)
            self._align_reference(self.reference)

    def _align_reference(self, source: Path) -> None:
        if self.reference_shift:
            shifted = source.with_name(source.stem + "-aligned.wav")
            shift_audio(source, shifted, self.reference_shift, self.cancel)
            shifted.replace(source)

    def _recover_stems(self) -> None:
        if self.exact_stems:
            return
        recovered = (
            verified_backing_gain(self.mix, self.project, self.cancel) if self.trusted else None
        )
        if recovered is not None:
            self.vocal = self.work / "recovered-vocal.wav"
            self.renderer._mix(
                self.mix,
                self.project,
                f"[1:a]volume={-recovered['gain']:.12f}[n];"
                "[0:a][n]amix=inputs=2:duration=first:normalize=0[out]",
                ["-c:a", "pcm_f32le", str(self.vocal)],
                self.cancel,
            )
            self.report["stemRecovery"] = {"method": "verified-project-subtraction", **recovered}
        elif not self.trusted:
            self.recorded_backing = self.work / "residual-backing.wav"
            self.renderer._mix(
                self.mix,
                self.vocal,
                "[1:a]volume=-1[v];[0:a][v]amix=inputs=2:duration=first:normalize=0[out]",
                ["-c:a", "pcm_f32le", str(self.recorded_backing)],
                self.cancel,
            )

    def _decode_original(self, source: Path) -> Path:
        try:
            sf.info(source)
            return source
        except sf.LibsndfileError:
            # FFmpeg supports imported AAC/M4A/WMA/video containers; verify its PCM.
            decoded = self.work / "original-decoded.wav"
            self.renderer._mix(
                source,
                source,
                "[0:a]anull[out]",
                [
                    "-ac",
                    str(self.channels),
                    "-ar",
                    str(self.info.samplerate),
                    "-c:a",
                    "pcm_f32le",
                    str(decoded),
                ],
                self.cancel,
            )
            return decoded

    def _optional_original(self) -> Path | None:
        self.report["originalMixStatus"] = "reference-stems-used"
        if not self.trusted or self.original_mix is None or not self.original_mix.is_file():
            return None
        try:
            original = self.work / "original-timeline.wav"
            coverage = self._timeline(self._decode_original(self.original_mix), original)
            self.report["originalMixCoverage"] = coverage
            if coverage < 0.999:
                self.report["originalMixStatus"] = "incomplete-reference-stems-used"
                return None
            self._align_reference(original)
        except (DependencyError, OSError, sf.LibsndfileError):
            _check_cancel(self.cancel)
            self.report["originalMixStatus"] = "unreadable-reference-stems-used"
            return None
        self.report["originalMixStatus"] = "performed-original-mix"
        return original


def prepare_sources(
    renderer: MasterRenderer,
    vocal: Path,
    recorded_backing: Path,
    reference_vocal: Path,
    original_backing: Path,
    mix: Path,
    work: Path,
    cancel: threading.Event,
    adjustments: Sequence[Mapping[str, object]],
    *,
    exact_stems: bool,
    original_mix: Path | None = None,
) -> MasterSources:
    return _SourcePreparation(
        renderer,
        vocal,
        recorded_backing,
        reference_vocal,
        original_backing,
        mix,
        work,
        cancel,
        adjustments,
        exact_stems,
        original_mix,
    ).run()
