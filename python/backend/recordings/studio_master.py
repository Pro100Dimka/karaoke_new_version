from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import threading

from backend.domain_errors import DependencyError
from backend.infrastructure.process_runner import ProcessRunner
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
        original_balance = _clamp(reference_db - original_db, -8.0, 1.0)
        vocal_gain = _clamp(original_balance - (user_db - performance_db), -8.0, 12.0)
        target.parent.mkdir(parents=True, exist_ok=True)
        self._render_audio(user_vocal, performance_instrumental, target, vocal_gain, cancel)
        return StudioMasterBalance(vocal_gain, user_db, performance_db, reference_db, original_db)

    def _render_audio(
        self,
        vocal: Path,
        instrumental: Path,
        target: Path,
        vocal_gain: float,
        cancel: threading.Event,
    ) -> None:
        analysis = self._runner.run(
            [self._ffmpeg, "-hide_banner", "-nostats", "-i", str(vocal), "-i", str(instrumental),
             "-filter_complex", self._filter_graph(vocal_gain, self._analysis_loudnorm()),
             "-map", "[out]", "-f", "null", "-"],
            timeout_seconds=900,
            cancel=cancel,
        )
        measured = self._parse_loudness(analysis.stderr) if analysis.exit_code == 0 else None
        if measured is None:
            raise DependencyError("StudioMasterFailed", "Studio master loudness analysis failed")
        result = self._runner.run(
            [self._ffmpeg, "-v", "error", "-y", "-i", str(vocal), "-i", str(instrumental),
             "-filter_complex", self._filter_graph(vocal_gain, self._render_loudnorm(measured)),
             "-map", "[out]", "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(target)],
            timeout_seconds=900,
            cancel=cancel,
        )
        if result.exit_code != 0 or not target.is_file():
            raise DependencyError("StudioMasterFailed", "Studio master rendering failed")

    @staticmethod
    def _filter_graph(vocal_gain: float, loudnorm: str) -> str:
        return (
            "[0:a]highpass=f=70,lowpass=f=17000,afftdn=nr=5:nf=-55,"
            "deesser=i=0.14:m=0.50:f=0.5,"
            "equalizer=f=180:t=q:w=1.2:g=-1.2,equalizer=f=3200:t=q:w=1.0:g=1.8,"
            "acompressor=threshold=0.10:ratio=3:attack=10:release=120:makeup=1.5,"
            f"volume={vocal_gain:.3f}dB[vocal];"
            "[1:a]highpass=f=28,aformat=channel_layouts=stereo,"
            "stereotools=mlev=1.0:slev=1.06,volume=0dB[backing];"
            "[backing][vocal]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
            "equalizer=f=280:t=q:w=0.9:g=-0.8,equalizer=f=3500:t=q:w=1.0:g=0.7,"
            "acompressor=threshold=0.18:ratio=1.6:attack=30:release=220:makeup=1.15,"
            "aexciter=amount=0.15:drive=3:blend=0.08:freq=7000:ceil=18000,"
            f"alimiter=limit=0.891:attack=5:release=50,{loudnorm}[out]"
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
            self._mean_volume(user_vocal, cancel),
            self._mean_volume(performance_instrumental, cancel),
            self._mean_volume(reference_vocal, cancel),
            self._mean_volume(original_instrumental, cancel),
        )

    def _mean_volume(self, path: Path, cancel: threading.Event) -> float:
        result = self._runner.run(
            [
                self._ffmpeg,
                "-hide_banner",
                "-nostats",
                "-i",
                str(path),
                "-af",
                "volumedetect",
                "-f",
                "null",
                "-",
            ],
            timeout_seconds=300,
            cancel=cancel,
        )
        match = re.search(rb"mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB", result.stderr)
        if result.exit_code != 0 or match is None or match.group(1) == b"-inf":
            raise DependencyError("StudioMasterSilentTrack", "A required mastering stem is silent")
        return float(match.group(1))


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))
