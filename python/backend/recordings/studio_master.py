from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import threading
import math
import os
import shutil
from tempfile import TemporaryDirectory

import soundfile as sf

from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.ffmpeg_audio import loudnorm_filter, parse_loudness
from backend.infrastructure.paths import ensure_within


@dataclass(frozen=True, slots=True)
class StudioMasterBalance:
    vocal_gain_db: float
    user_vocal_db: float
    performance_instrumental_db: float
    reference_vocal_db: float
    original_instrumental_db: float

    def payload(self) -> dict[str, float]:
        return {
            "vocalGainDb": self.vocal_gain_db,
            "userVocalDb": self.user_vocal_db,
            "performanceInstrumentalDb": self.performance_instrumental_db,
            "referenceVocalDb": self.reference_vocal_db,
            "originalInstrumentalDb": self.original_instrumental_db,
        }


class FfmpegStudioMasterRenderer:
    """Masters the recorded performance, retaining its wet voice and musical timeline."""

    def __init__(self, runner: ProcessRunner, ffmpeg: str = "ffmpeg") -> None:
        self._runner = runner
        self._ffmpeg = ffmpeg

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
        audio_format: tuple[int, int] = (48000, 2),
        enhance: bool = True,
    ) -> StudioMasterBalance:
        levels = self._levels(
            user_vocal, performance_instrumental, reference_vocal, original_instrumental, cancel
        )
        user_db, performance_db, reference_db, original_db = levels
        # Compare ratios, not absolute stem levels: restoring the project's full-volume backing
        # used to bury a voice that was already clearly audible over the recorded accompaniment.
        vocal_gain = (reference_db - original_db) - (user_db - performance_db)
        target.parent.mkdir(parents=True, exist_ok=True)
        # Separation can classify echo/reverb as accompaniment. Keep the original mixed take;
        # the separated voice only supplements it when needed, never replaces the wet voice.
        correction = user_vocal if vocal_gain >= 0 else performance_instrumental
        self._render_audio(
            performance_mix,
            correction,
            target,
            vocal_gain,
            cancel,
            audio_format=audio_format,
            enhance=enhance,
        )
        return StudioMasterBalance(vocal_gain, user_db, performance_db, reference_db, original_db)

    def balance_recording(self, path: Path, reference: Path, instrumental: Path) -> None:
        backing = ensure_within(Path(str(path) + ".backing.wav"), path.parent)
        if not backing.is_file():
            return
        original = ensure_within(path.with_name(f"{path.stem}.original.wav"), path.parent)
        source = original if original.is_file() else path
        with TemporaryDirectory(prefix=".balance-", dir=path.parent) as directory:
            vocal, target = Path(directory) / "vocal.wav", Path(directory) / "balanced.wav"
            result = self._mix(
                source,
                backing,
                "[1:a]volume=-1[backing];[0:a][backing]amix=inputs=2:duration=first:normalize=0[out]",
                ["-c:a", "pcm_f32le", str(vocal)],
                threading.Event(),
                quiet=True,
            )
            if result.exit_code != 0:
                raise DependencyError("RecordingBalanceFailed", "Cannot isolate the recorded voice")
            info = sf.info(source)
            try:
                self.render(
                    vocal,
                    backing,
                    reference,
                    instrumental,
                    target,
                    threading.Event(),
                    performance_mix=source,
                    audio_format=(info.samplerate, info.channels),
                    enhance=False,
                )
            except DependencyError as error:
                if error.code == "StudioMasterSilentTrack":
                    backing.unlink()
                    return
                raise
            if not original.is_file():
                shutil.copy2(path, original)
            os.replace(target, path)
            backing.unlink()

    def _render_audio(
        self,
        performance: Path,
        vocal: Path,
        target: Path,
        vocal_gain: float,
        cancel: threading.Event,
        *,
        audio_format: tuple[int, int] = (48000, 2),
        enhance: bool = True,
    ) -> None:
        rate, channels = audio_format
        loudness = "anull"
        if enhance:
            analysis = self._mix(
                performance,
                vocal,
                self._filter_graph(vocal_gain, loudnorm_filter(), enhance),
                ["-f", "null", "-"],
                cancel,
                quiet=False,
            )
            measured = parse_loudness(analysis.stderr) if analysis.exit_code == 0 else None
            if measured is None:
                raise DependencyError(
                    "StudioMasterFailed", "Studio master loudness analysis failed"
                )
            loudness = loudnorm_filter(measured)
        result = self._mix(
            performance,
            vocal,
            self._filter_graph(vocal_gain, loudness, enhance),
            ["-ar", str(rate), "-ac", str(channels), "-c:a", "pcm_s16le", str(target)],
            cancel,
            quiet=True,
        )
        if result.exit_code != 0 or not target.is_file():
            raise DependencyError("StudioMasterFailed", "Studio master rendering failed")

    def _mix(
        self,
        performance: Path,
        vocal: Path,
        filter_graph: str,
        output: list[str],
        cancel: threading.Event,
        *,
        quiet: bool,
    ) -> ProcessResult:
        """Runs FFmpeg on the vocal and instrumental through `filter_graph` into `output`.

        The loudness pass needs FFmpeg's report on stderr; the render pass needs only errors."""
        verbosity = ["-v", "error", "-y"] if quiet else ["-hide_banner", "-nostats"]
        return self._runner.run(
            [
                self._ffmpeg,
                *verbosity,
                "-i",
                str(performance),
                "-i",
                str(vocal),
                "-filter_complex",
                filter_graph,
                "-map",
                "[out]",
                *output,
            ],
            timeout_seconds=900,
            cancel=cancel,
        )

    @staticmethod
    def _filter_graph(vocal_gain: float, loudnorm: str, enhance: bool = True) -> str:
        # Preserve the wet take. Raise a quiet voice with its separated stem; lower a loud
        # voice by attenuating the take and restoring only the missing accompaniment.
        gain = math.exp(vocal_gain * math.log(10) / 20)
        supplement = abs(gain - 1)
        effects = (
            (
                "equalizer=f=280:t=q:w=0.9:g=-0.8,equalizer=f=3500:t=q:w=1.0:g=0.7,"
                "acompressor=threshold=0.18:ratio=1.45:attack=30:release=220:makeup=1.08,"
            )
            if enhance
            else ""
        )
        limiter = ",alimiter=limit=0.891:attack=5:release=50:level=false"
        return (
            f"[0:a]volume={min(1, gain):.9f}[take];"
            f"[1:a]volume={supplement:.9f}[boost];"
            "[take][boost]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
            f"{effects}{loudnorm}{limiter}[out]"
        )

    def _levels(
        self,
        user_vocal: Path,
        performance_instrumental: Path,
        reference_vocal: Path,
        original_instrumental: Path,
        cancel: threading.Event,
    ) -> tuple[float, float, float, float]:
        return (
            self._integrated_loudness(user_vocal, cancel),
            self._integrated_loudness(performance_instrumental, cancel),
            self._integrated_loudness(reference_vocal, cancel),
            self._integrated_loudness(original_instrumental, cancel),
        )

    def _integrated_loudness(self, path: Path, cancel: threading.Event) -> float:
        result = self._runner.run(
            [
                self._ffmpeg,
                "-hide_banner",
                "-nostats",
                "-i",
                str(path),
                "-af",
                "ebur128=framelog=verbose",
                "-f",
                "null",
                "-",
            ],
            timeout_seconds=300,
            cancel=cancel,
        )
        matches = re.findall(rb"\bI:\s*(-?(?:inf|\d+(?:\.\d+)?))\s+LUFS", result.stderr)
        if result.exit_code != 0 or not matches or matches[-1] == b"-inf":
            raise DependencyError("StudioMasterSilentTrack", "A required mastering stem is silent")
        return float(matches[-1])
