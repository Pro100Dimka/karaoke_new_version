from __future__ import annotations

import threading
from pathlib import Path
from typing import Mapping, Sequence

from backend.ai.domain import AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.infrastructure.paths import ensure_within
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.process_runner import ProcessRunner
from backend.lyrics.ports import LyricLineTiming
from backend.lyrics.codec import decode_rhythm
from backend.serialization import JsonValue, dumps, loads_object
from backend.songs.domain import Language
from backend.processing.compute_policy import ExecutionContext

_RecognitionKey = tuple[threading.Event, Path, Language, str, str]


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
        self._recognitions: dict[_RecognitionKey, dict[str, JsonValue]] = {}
        self._recognition_lock = threading.Lock()

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
        raw = (
            ensure_within(Path(_text(payload, "rawVocal")), workdir)
            if "rawVocal" in payload
            else None
        )
        preparation = payload.get("preparation", {})
        if (raw is not None and not raw.is_file()) or not isinstance(preparation, dict):
            raise DependencyError("AiProviderInvalidOutput", "Vocal preparation output is invalid")
        return SeparatedAudio(
            instrumental, vocal, decode_rhythm(payload.get("rhythm", [])), raw, preparation
        )

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
        start_seconds: float = 0.0,
    ) -> str:
        key = (
            self._recognition_key(vocal, language, cancel, execution) if not start_seconds else None
        )
        payload = self._invoke(
            "transcribe",
            [
                "--input",
                str(vocal),
                "--language",
                language.value,
                "--start-seconds",
                str(start_seconds),
            ],
            cancel,
            execution=execution,
        )
        transcript = payload.get("text")
        if not isinstance(transcript, str):
            raise DependencyError("AiProviderInvalidOutput", "AI provider field text is invalid")
        if key is not None and isinstance(payload.get("segments"), list):
            with self._recognition_lock:
                self._recognitions[key] = payload
                if len(self._recognitions) > 4:
                    self._recognitions.pop(next(iter(self._recognitions)))
        return transcript

    def _recognition_key(
        self, vocal: Path, language: Language, cancel: threading.Event, execution: ExecutionContext
    ) -> _RecognitionKey | None:
        if self._descriptor.provider_id != "local-torch" or not vocal.is_file():
            return None
        return cancel, vocal.resolve(), language, execution.device.value, sha256_file(vocal)

    def _recognition_for(
        self, vocal: Path, language: Language, cancel: threading.Event, execution: ExecutionContext
    ) -> dict[str, JsonValue] | None:
        key = self._recognition_key(vocal, language, cancel, execution)
        with self._recognition_lock:
            recognition = self._recognitions.get(key) if key is not None else None
            cached = list(self._recognitions.items())
        if recognition is None or key is None:
            return None
        alternatives: list[JsonValue] = [
            payload
            for other, payload in cached
            if other != key
            and (other[0], other[2], other[3]) == (key[0], key[2], key[3])
            and self._recognition_key(other[1], language, cancel, execution) == other
        ]
        return {**recognition, "alternatives": alternatives}

    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        timing_hints: Sequence[LyricLineTiming] = (),
        execution: ExecutionContext,
        instrumental: Path | None = None,
    ) -> Sequence[WordTiming]:
        arguments = ["--input", str(vocal), "--language", language.value, "--lyrics", lyrics]
        if instrumental is not None:
            arguments.extend(["--instrumental", str(instrumental)])
        if timing_hints:
            arguments.extend(
                [
                    "--timing-hints",
                    dumps([{"start": hint.start, "text": hint.text} for hint in timing_hints]),
                ]
            )
        recognition = self._recognition_for(vocal, language, cancel, execution)
        if recognition is not None:
            arguments.append("--recognition-stdin")
        payload = self._invoke(
            "align",
            arguments,
            cancel,
            execution=execution,
            input_data=dumps(recognition).encode("utf-8") if recognition is not None else None,
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
        input_data: bytes | None = None,
    ) -> dict[str, JsonValue]:
        try:
            result = self._runner.run(
                [*self._command, action, *arguments],
                timeout_seconds=self._timeout,
                cancel=cancel,
                input_data=input_data,
                environment={
                    **_thread_environment(execution.cpu_threads),
                    "AD_VOICE_COMPUTE_DEVICE": execution.device.value.lower(),
                },
            )
        except DomainError as error:
            if error.code != "ProcessCancelled":
                raise
            raise ConflictError("JobCancelled", "Local AI processing was cancelled") from error
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
    diagnostics = value.get("diagnostics", [])
    return WordTiming(
        _text(value, "text"),
        start,
        end,
        _number(value, "confidence"),
        starts,
        tuple(item for item in diagnostics if isinstance(item, str))
        if isinstance(diagnostics, list)
        else (),
    )


def _pitch(value: JsonValue) -> PitchPoint:
    if not isinstance(value, dict):
        raise DependencyError("AiProviderInvalidOutput", "Pitch item is malformed")
    active = value.get("audioActive")
    return PitchPoint(
        _number(value, "time"),
        _number(value, "frequency"),
        _number(value, "confidence"),
        active if isinstance(active, bool) else None,
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
