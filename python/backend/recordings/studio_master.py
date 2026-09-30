from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import threading

from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.serialization import loads_object


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
    """Balances separated performance stems against the original song and renders a safe master."""

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
    ) -> StudioMasterBalance:
        levels = self._levels(
            user_vocal, performance_instrumental, reference_vocal, original_instrumental, cancel
        )
        user_db, performance_db, reference_db, original_db = levels
        # Reproduce the released song's vocal-to-instrumental balance against the instrumental
        # that is actually rendered, the original one: the singer's vocal is brought to the loudness
        # the released vocal has there.  The performance backing is not a reference, because
        # karaoke lowers it under quiet voices; its level is only reported.  The compressor and
        # limiter after the gain keep a raised vocal's peaks in range.
        vocal_gain = reference_db - user_db
        target.parent.mkdir(parents=True, exist_ok=True)
        # The separated performance backing already contains separation artefacts.  It is useful
        # for measuring the singer's balance, but the released project instrumental is the clean
        # source that belongs in the final master.
        self._render_audio(user_vocal, original_instrumental, target, vocal_gain, cancel)
        return StudioMasterBalance(vocal_gain, user_db, performance_db, reference_db, original_db)

    def _render_audio(
        self,
        vocal: Path,
        instrumental: Path,
        target: Path,
        vocal_gain: float,
        cancel: threading.Event,
    ) -> None:
        # Two passes of one mix: the first measures its loudness, the second renders it normalised.
        analysis = self._mix(
            vocal,
            instrumental,
            self._filter_graph(vocal_gain, self._analysis_loudnorm()),
            ["-f", "null", "-"],
            cancel,
            quiet=False,
        )
        measured = self._parse_loudness(analysis.stderr) if analysis.exit_code == 0 else None
        if measured is None:
            raise DependencyError("StudioMasterFailed", "Studio master loudness analysis failed")
        result = self._mix(
            vocal,
            instrumental,
            self._filter_graph(vocal_gain, self._render_loudnorm(measured)),
            ["-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(target)],
            cancel,
            quiet=True,
        )
        if result.exit_code != 0 or not target.is_file():
            raise DependencyError("StudioMasterFailed", "Studio master rendering failed")

    def _mix(
        self,
        vocal: Path,
        instrumental: Path,
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
                str(vocal),
                "-i",
                str(instrumental),
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
    def _filter_graph(vocal_gain: float, loudnorm: str) -> str:
        return (
            "[0:a]highpass=f=70,lowpass=f=17000,afftdn=nr=5:nf=-55,"
            "deesser=i=0.14:m=0.50:f=0.5,"
            "equalizer=f=180:t=q:w=1.2:g=-1.2,equalizer=f=3200:t=q:w=1.0:g=1.8,"
            "acompressor=threshold=0.10:ratio=2.4:attack=12:release=140:makeup=1.25,"
            f"volume={vocal_gain:.3f}dB,alimiter=limit=0.794:attack=5:release=80[vocal];"
            "[1:a]highpass=f=28,aformat=channel_layouts=stereo,"
            "stereotools=mlev=1.0:slev=1.04,volume=0dB[backing];"
            "[backing][vocal]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
            "equalizer=f=280:t=q:w=0.9:g=-0.8,equalizer=f=3500:t=q:w=1.0:g=0.7,"
            "acompressor=threshold=0.18:ratio=1.45:attack=30:release=220:makeup=1.08,"
            f"{loudnorm},alimiter=limit=0.891:attack=5:release=50[out]"
        )

    @staticmethod
    def _analysis_loudnorm() -> str:
        return "loudnorm=I=-14:LRA=7:TP=-1:print_format=json"

    @staticmethod
    def _render_loudnorm(measured: dict[str, float]) -> str:
        return (
            "loudnorm=I=-14:LRA=7:TP=-1:linear=true:"
            f"measured_I={measured['input_i']}:measured_LRA={measured['input_lra']}:"
            f"measured_TP={measured['input_tp']}:measured_thresh={measured['input_thresh']}:"
            f"offset={measured['target_offset']}"
        )

    @staticmethod
    def _parse_loudness(stderr: bytes) -> dict[str, float] | None:
        match = re.search(rb'\{\s*"input_i".*?\}', stderr, re.DOTALL)
        if match is None:
            return None
        try:
            payload = loads_object(match.group(0).decode("utf-8"))
            keys = ("input_i", "input_lra", "input_tp", "input_thresh", "target_offset")
            return {key: float(payload[key]) for key in keys}
        except (KeyError, TypeError, ValueError, UnicodeDecodeError):
            return None

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
