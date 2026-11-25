"""The solo vocal chain applied independently to each room microphone."""

from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from backend.recordings.room_source_alignment import align_room_captures
from backend.recordings.studio_adaptive_balance import plan_balance
from backend.recordings.studio_adaptive_voice import prepare_voice, process_voice
from backend.recordings.studio_arrangement import ArrangementMap
from backend.recordings.studio_audio import (
    MasterRenderer,
    _check_cancel,
    _profile,
    _temporary_wave,
    _write_gain_envelope,
)
from backend.recordings.studio_parallel import ordered_map
from backend.recordings.studio_voice_analysis import VoiceAnalysisCache


def render_room_voices(
    renderer: MasterRenderer,
    sources: Mapping[str, Sequence[Path]],
    timeline: Path,
    target: Path,
    backing: Path,
    reference_vocal: Path | None,
    reference_backing: Path | None,
    arrangement: ArrangementMap,
    cancel: threading.Event,
) -> dict[str, object]:
    info = sf.info(backing)
    analysis = VoiceAnalysisCache()
    if sources and reference_vocal is not None:
        analysis.measure(reference_vocal, cancel)

    def singer(item: tuple[int, tuple[str, Sequence[Path]]]) -> tuple[str, Path, dict[str, object]]:
        index, (identity, source) = item
        aligned, edited, processed, balanced = (
            target.with_stem(f"singer-{index}-{stage}")
            for stage in ("aligned", "edited", "processed", "balanced")
        )
        align_room_captures(
            renderer,
            source,
            timeline,
            aligned,
            cancel,
            frames=info.frames,
            rate=info.samplerate,
            channels=info.channels,
        )
        preparation = prepare_voice(
            renderer,
            aligned,
            edited,
            cancel,
            reference=reference_vocal,
            analysis=analysis,
        )
        chain = process_voice(
            renderer,
            edited,
            processed,
            cancel,
            reference=reference_vocal,
            arrangement=arrangement,
            analysis=analysis,
        )
        plan = plan_balance(processed, backing, reference_vocal, reference_backing, cancel)
        _write_gain_envelope(processed, balanced, plan.times, plan.gains, cancel)
        levels = _profile(balanced, cancel)
        active = levels[levels > max(-100, float(np.percentile(levels, 90)) - 45)]
        return (
            identity,
            balanced,
            {
                "captureCount": len(source),
                "preparation": preparation,
                "vocalChain": chain,
                "balance": plan.report,
                "outputLevelDb": float(np.median(active)) if len(active) else -120.0,
            },
        )

    voices = tuple(ordered_map(singer, tuple(enumerate(sources.items()))))
    with ExitStack() as opened:
        inputs = [opened.enter_context(sf.SoundFile(path)) for _, path, _ in voices]
        output = opened.enter_context(
            _temporary_wave(target, samplerate=info.samplerate, channels=info.channels)
        )
        for offset in range(0, info.frames, 65536):
            _check_cancel(cancel)
            count = min(65536, info.frames - offset)
            samples = np.zeros((count, info.channels), dtype="float32")
            for voice in inputs:
                samples += voice.read(count, dtype="float32", always_2d=True)
            output.write(samples)
    return {identity: report for identity, _, report in voices}
