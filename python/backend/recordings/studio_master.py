from __future__ import annotations
from backend.recordings.studio_render import MasterRender

from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
import os
import threading


from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.paths import ensure_within


from backend.recordings.studio_audio import (
    StudioMasterBalance as StudioMasterBalance,
    _MAX_BOOST_DB as _MAX_BOOST_DB,
    _PROFILE_SECONDS as _PROFILE_SECONDS,
    _check_cancel as _check_cancel,
    _profile as _profile,
    recording_stems as recording_stems,
)
from backend.recordings.studio_dynamics import _balance_curve, _voice_filters
from backend.recordings.studio_spectrum import _repeated_output_channels, _unmask_backing
from backend.recordings.studio_reference import _reference_offset


class FfmpegStudioMasterRenderer:
    """Processes the recorded voice independently, retaining the accompaniment and timeline."""

    _balance_curve = staticmethod(_balance_curve)
    _voice_filters = staticmethod(_voice_filters)
    _repeated_output_channels = staticmethod(_repeated_output_channels)
    _unmask_backing = staticmethod(_unmask_backing)
    _reference_offset = staticmethod(_reference_offset)

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
            self._mix(
                source,
                backing,
                "[1:a]volume=-1[b];[0:a][b]amix=inputs=2:duration=first:normalize=0[out]",
                ["-c:a", "pcm_f32le", str(temporary)],
                threading.Event(),
            )
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
        match_recording_loudness: bool = False,
        adjustments: Sequence[Mapping[str, object]] = (),
        progress: Callable[[str, float, float], None] | None = None,
    ) -> StudioMasterBalance:
        return MasterRender(
            self,
            user_vocal,
            performance_instrumental,
            reference_vocal,
            original_instrumental,
            target,
            cancel,
            performance_mix,
            exact_stems,
            process_voice,
            match_recording_loudness,
            adjustments,
            progress,
        ).run()

    def _mix(
        self,
        first: Path,
        second: Path,
        filter_graph: str,
        output: list[str],
        cancel: threading.Event,
        *,
        quiet: bool = True,
    ) -> ProcessResult:
        result = self._runner.run(
            [
                self._ffmpeg,
                "-hide_banner",
                "-nostats",
                "-v",
                "error" if quiet else "info",
                "-y",
                "-i",
                str(first),
                "-i",
                str(second),
                "-filter_complex_threads",
                "1",
                "-filter_complex",
                filter_graph,
                "-map",
                "[out]",
                *output,
            ],
            timeout_seconds=900,
            cancel=cancel,
        )
        if result.exit_code != 0:
            raise DependencyError("StudioMasterFailed", "Studio master audio processing failed")
        return result
