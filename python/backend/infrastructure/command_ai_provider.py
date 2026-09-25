from __future__ import annotations

import threading
from pathlib import Path
from typing import Mapping, Sequence

from backend.ai.domain import AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.domain_errors import DependencyError
from backend.infrastructure.paths import ensure_within
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.ports import LyricLineTiming
from backend.serialization import JsonValue, dumps, loads_object
from backend.songs.domain import Language
from backend.processing.compute_policy import ExecutionContext


class CommandAiProvider:
    def __init__(
        self,
        descriptor: AiProviderDescriptor,
        command: Sequence[str],
        runner: ProcessRunner,
        *,
        timeout_seconds: float = 1800,
    ) -> None:
        self._descriptor = descriptor
        self._command = tuple(command)
        self._runner = runner
        self._timeout = timeout_seconds

    @property
    def descriptor(self) -> AiProviderDescriptor:
        return self._descriptor

    def separate(
        self, audio: Path, workdir: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> SeparatedAudio:
        payload = self._invoke(
            "separate",
            ["--input", str(audio), "--output", str(workdir)],
            cancel,
            execution=execution,
        )
        instrumental = ensure_within(Path(_text(payload, "instrumental")), workdir)
        vocal = ensure_within(Path(_text(payload, "referenceVocal")), workdir)
        if not instrumental.is_file() or not vocal.is_file():
            raise DependencyError("AiProviderInvalidOutput", "Separation output files are missing")
        return SeparatedAudio(instrumental, vocal)

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> str:
        payload = self._invoke(
            "transcribe",
            ["--input", str(vocal), "--language", language.value],
            cancel,
            execution=execution,
        )
        transcript = payload.get("text")
        if not isinstance(transcript, str):
            raise DependencyError("AiProviderInvalidOutput", "AI provider field text is invalid")
        return transcript

    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        timing_hints: Sequence[LyricLineTiming] = (),
        execution: ExecutionContext,
    ) -> Sequence[WordTiming]:
        arguments = [
            "--input",
            str(vocal),
            "--language",
            language.value,
            "--lyrics",
            lyrics,
        ]
        if timing_hints:
            arguments.extend(
                [
                    "--timing-hints",
                    dumps(
                        [
                            {"start": hint.start, "text": hint.text}
                            for hint in timing_hints
                        ]
                    ),
                ]
            )
        payload = self._invoke(
            "align",
            arguments,
            cancel,
            execution=execution,
        )
        values = payload.get("words")
        if not isinstance(values, list):
            raise DependencyError("AiProviderInvalidOutput", "Alignment response is malformed")
        return tuple(_word(value) for value in values)

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]:
        payload = self._invoke("pitch", ["--input", str(vocal)], cancel, execution=execution)
        values = payload.get("points")
        if not isinstance(values, list):
            raise DependencyError("AiProviderInvalidOutput", "Pitch response is malformed")
        return tuple(_pitch(value) for value in values)

    def _invoke(
        self,
        action: str,
        arguments: Sequence[str],
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> dict[str, JsonValue]:
        result = self._runner.run(
            [*self._command, action, *arguments],
            timeout_seconds=self._timeout,
            cancel=cancel,
            environment={
                **_thread_environment(execution.cpu_threads),
                "AD_VOICE_COMPUTE_DEVICE": execution.device.value.lower(),
            },
        )
        if result.exit_code != 0:
            raise DependencyError(
                "AiProviderFailed",
                "AI provider process failed",
                providerId=self._descriptor.provider_id,
                exitCode=result.exit_code,
            )
        try:
            return loads_object(result.stdout.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise DependencyError(
                "AiProviderInvalidOutput", "AI provider returned malformed JSON"
            ) from exc


def _thread_environment(threads: int) -> Mapping[str, str]:
    value = str(threads)
    return {
        "OMP_NUM_THREADS": value,
        "MKL_NUM_THREADS": value,
        "OPENBLAS_NUM_THREADS": value,
        "NUMEXPR_NUM_THREADS": value,
    }


def _word(value: JsonValue) -> WordTiming:
    if not isinstance(value, dict):
        raise DependencyError("AiProviderInvalidOutput", "Alignment item is malformed")
    start, end = _number(value, "start"), _number(value, "end")
    if start < 0 or end <= start:
        raise DependencyError("AiProviderInvalidOutput", "Alignment word has no positive duration")
    letters = value.get("letters")
    starts = (
        tuple(float(item) for item in letters if isinstance(item, int | float))
        if isinstance(letters, list)
        else ()
    )
    return WordTiming(_text(value, "text"), start, end, _number(value, "confidence"), starts)


def _pitch(value: JsonValue) -> PitchPoint:
    if not isinstance(value, dict):
        raise DependencyError("AiProviderInvalidOutput", "Pitch item is malformed")
    return PitchPoint(
        _number(value, "time"),
        _number(value, "frequency"),
        _number(value, "confidence"),
    )


def _text(value: dict[str, JsonValue], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise DependencyError("AiProviderInvalidOutput", f"AI provider field {key} is invalid")
    return item


def _number(value: dict[str, JsonValue], key: str) -> float:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int | float):
        raise DependencyError("AiProviderInvalidOutput", f"AI provider field {key} is invalid")
    return float(item)
