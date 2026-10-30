from __future__ import annotations

from dataclasses import dataclass, replace
from collections.abc import Callable
from collections import Counter

from backend.ai.domain import PitchPoint, WordTiming
from backend.lyrics.discovery import LyricsDiscovery, LyricsDiscoveryResult, lyrics_language
from backend.lyrics.domain import LyricsDocument
from backend.lyrics.phrases import _lyrics_key
from backend.processing.algorithms import construct_document, stabilize_pitch
from backend.processing.audio_pipeline import PreparedAudio
from backend.processing.domain import CancellationPolicy, ProcessingOptions, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.processing.policies import concurrent_stage_thread_split
from backend.processing.ports import ConcurrentRunner
from backend.processing.reporting import alignment_warnings, pitch_warnings
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Song


@dataclass(frozen=True, slots=True)
class BuiltDocument:
    document: LyricsDocument
    discovery: LyricsDiscoveryResult
    warnings: tuple[str, ...]


def _word_support(word: WordTiming) -> bool:
    return "RecognizedWord" in word.diagnostics or (
        word.confidence >= 0.1 and "ApproximateAlignment" not in word.diagnostics
    )


def _repeat_support(lines: list[str], words: tuple[WordTiming, ...]) -> list[float]:
    evidence, first = [], 0
    for line in lines:
        last = first + len(line.split())
        span = words[first:last]
        supported = sum(len(_lyrics_key(word.text)) for word in span if _word_support(word))
        evidence.append(
            supported / max(1, len(_lyrics_key(line))) if span and _word_support(span[0]) else 0.0
        )
        first = last
    return evidence


def _verified_repeats(
    discovery: LyricsDiscoveryResult, words: tuple[WordTiming, ...]
) -> LyricsDiscoveryResult:
    """Keep the catalogue floor and independently supported surplus occurrences."""
    if not discovery.repeat_baseline or discovery.unverified_repeat_lyrics:
        return discovery
    lines = discovery.lyrics.splitlines()
    baseline = Counter(_lyrics_key(line) for line in discovery.repeat_baseline.splitlines())
    keys = [_lyrics_key(line) for line in lines]
    support = _repeat_support(lines, words)
    allowed = baseline | Counter(key for key, value in zip(keys, support) if value >= 0.6)
    surplus = Counter(keys) - allowed
    removed = set()
    for index in sorted(range(len(lines)), key=support.__getitem__):
        if surplus[keys[index]]:
            removed.add(index)
            surplus[keys[index]] -= 1
    if allowed == baseline or [_lyrics_key(word.text) for word in words] != [
        _lyrics_key(word) for word in discovery.lyrics.split()
    ]:
        retained = discovery.repeat_baseline
    else:
        retained = "\n".join(line for index, line in enumerate(lines) if index not in removed)
    if retained == discovery.lyrics:
        return discovery
    return replace(
        discovery,
        lyrics=retained,
        timing_hints=discovery.repeat_baseline_hints
        if retained == discovery.repeat_baseline
        else discovery.timing_hints,
        unverified_repeat_lyrics=discovery.lyrics,
        warnings=tuple(
            warning
            for warning in discovery.warnings
            if warning != "LyricsRepeatsRecovered" or retained != discovery.repeat_baseline
        )
        + ("UnverifiedExtraRepeats",),
    )


class BuildProcessingDocument:
    """Build lyrics and pitch in parallel within the admitted CPU thread budget."""

    def __init__(
        self,
        discovery: LyricsDiscovery,
        stages: StageRunner,
        concurrency: ConcurrentRunner,
    ) -> None:
        self._discovery = discovery
        self._stages = stages
        self._concurrency = concurrency

    def run(
        self,
        song: Song,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        options: ProcessingOptions,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> BuiltDocument:
        align_threads, pitch_threads = concurrent_stage_thread_split(execution.cpu_threads)
        align_execution = replace(execution, cpu_threads=align_threads)
        pitch_execution = replace(execution, cpu_threads=pitch_threads)
        discovery = self._discover(song, prepared, providers, options, context, reports, execution)
        parallel = not discovery.timing_hints or execution.device is ComputeDevice.CUDA
        if not parallel:
            align_execution = pitch_execution = execution
        pitch_reports: list[StageReport] = []
        stable: tuple[PitchPoint, ...] = ()
        words: tuple[WordTiming, ...] = ()

        def run_pitch() -> None:
            nonlocal stable
            stable = self._stable_pitch(
                prepared, providers, context, pitch_reports, pitch_execution
            )

        def run_align() -> None:
            nonlocal words, discovery
            discovery, words = self._align(
                song, prepared, discovery, providers, context, reports, align_execution
            )

        self._run_stages(execution, run_align, run_pitch, parallel=parallel)
        reports.extend(pitch_reports)
        document = self._construct(song, prepared, discovery, words, stable, context, reports)
        warnings = (
            discovery.warnings
            + alignment_warnings(words, lyrics=discovery.lyrics, bpm=prepared.music.bpm)
            + pitch_warnings(stable)
        )
        return BuiltDocument(replace(document, rhythm=prepared.rhythm), discovery, warnings)

    def _run_stages(
        self, execution: ExecutionContext, *stages: Callable[[], None], parallel: bool
    ) -> None:
        if parallel and execution.cpu_threads > 1:
            self._concurrency.run_concurrently(*stages)
        else:
            for stage in stages:
                stage()

    def _discover(
        self,
        song: Song,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        options: ProcessingOptions,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> LyricsDiscoveryResult:
        return self._stages.run(
            "LyricsDiscovery",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: self._discovery.discover(
                song,
                prepared.reference_vocal,
                providers.asr,
                context.cancel,
                online_enabled=options.online_lyrics,
                execution=execution,
            ),
            progress=0.60,
        )

    def _align(
        self,
        song: Song,
        prepared: PreparedAudio,
        discovery: LyricsDiscoveryResult,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[LyricsDiscoveryResult, tuple[WordTiming, ...]]:
        words = self._stages.run(
            "ForcedAlignment",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: providers.alignment.align(
                prepared.reference_vocal,
                discovery.lyrics,
                lyrics_language(song, discovery.lyrics),
                context.cancel,
                timing_hints=discovery.timing_hints,
                execution=execution,
                instrumental=prepared.instrumental,
            ),
            progress=0.72,
        )
        verified = _verified_repeats(discovery, tuple(words))
        if verified != discovery:
            # An invented repeat shifts real words too: realign the retained text.
            return self._align(song, prepared, verified, providers, context, reports, execution)
        return discovery, tuple(words)

    def _stable_pitch(
        self,
        prepared: PreparedAudio,
        providers: ProcessingProviders,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[PitchPoint, ...]:
        pitch = self._stages.run(
            "PitchAnalysis",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: providers.pitch.pitch(
                prepared.reference_vocal, context.cancel, execution=execution
            ),
            progress=0.82,
        )
        return self._stages.run(
            "PitchStabilization",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: stabilize_pitch(pitch),
            progress=0.87,
        )

    def _construct(
        self,
        song: Song,
        prepared: PreparedAudio,
        discovery: LyricsDiscoveryResult,
        words: tuple[WordTiming, ...],
        pitch: tuple[PitchPoint, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> LyricsDocument:
        return self._stages.run(
            "NoteConstruction",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: construct_document(
                song.title,
                song.artist,
                song.duration or 0.0,
                discovery.lyrics,
                words,
                pitch,
                prepared.music,
            ),
            progress=0.93,
        )
