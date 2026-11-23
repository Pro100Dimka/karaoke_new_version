from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from collections import OrderedDict
from pathlib import Path
from typing import Iterator, Sequence

from backend.ai.domain import (
    AlignedTranscript,
    AiProviderDescriptor,
    PitchPoint,
    SeparatedAudio,
    WordTiming,
)
from backend.ai.ports import TranscriptionSource
from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.infrastructure.ai_payloads import (
    _alignment_request,
    _alignment_words as _alignment_words,
    _pitch as _pitch,
    _source_view as _source_view,
    _text as _text,
    _transcription_requests,
    _transcription_text,
    _transcription_values,
    _word as _word,
)
from backend.infrastructure.paths import ensure_within
from backend.infrastructure.hashing import sha256_file
from backend.infrastructure.process_runner import ProcessInput, ProcessRunner, ProcessResult
from backend.infrastructure.speech_session import SpeechSession, execution_environment
from backend.lyrics.ports import LyricLineTiming
from backend.lyrics.codec import decode_rhythm
from backend.serialization import JsonValue, dumps, loads_object
from backend.songs.domain import Language
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.processing.policies import ResourceBudget

_RecognitionKey = tuple[threading.Event, Path, Language, str, str, float]


class CommandAiProvider:
    def __init__(
        self,
        descriptor: AiProviderDescriptor,
        command: Sequence[str],
        runner: ProcessRunner,
        *,
        timeout_seconds: float = 1800,
        resource_budget: ResourceBudget | None = None,
    ) -> None:
        self._descriptor = descriptor
        self._command = tuple(command)
        self._runner = runner
        self._timeout = timeout_seconds
        self._recognitions: dict[_RecognitionKey, dict[str, JsonValue]] = {}
        self._recognition_lock = threading.Lock()
        self._pitch_results: OrderedDict[tuple[str, ExecutionContext], tuple[PitchPoint, ...]] = (
            OrderedDict()
        )
        self._budget = resource_budget
        self._alignment_workspaces: dict[threading.Event, Path] = {}
        self._speech_sessions: dict[threading.Event, tuple[SpeechSession, ComputeDevice]] = {}

    @contextmanager
    def reuse_speech(self, cancel: threading.Event, execution: ExecutionContext) -> Iterator[None]:
        if execution.device is not ComputeDevice.CUDA:
            yield
            return
        with self.reuse_pitch(cancel, execution):
            yield

    @contextmanager
    def reuse_pitch(self, cancel: threading.Event, execution: ExecutionContext) -> Iterator[None]:
        if (
            self._descriptor.provider_id != "local-torch"
            or execution.cpu_fraction is not None
            or not isinstance(self._runner, ProcessRunner)
        ):
            yield
            return
        session = SpeechSession(self._command)
        with self._recognition_lock:
            self._speech_sessions[cancel] = session, execution.device
        try:
            yield
        finally:
            with self._recognition_lock:
                self._speech_sessions.pop(cancel, None)
            session.close()

    @property
    def descriptor(self) -> AiProviderDescriptor:
        return self._descriptor

    @contextmanager
    def reuse_alignment(self, workdir: Path, cancel: threading.Event) -> Iterator[None]:
        if self._descriptor.provider_id != "local-torch" or self._budget is None:
            yield
            return
        with self._recognition_lock:
            self._alignment_workspaces[cancel] = workdir / "alignment-reuse"
        try:
            yield
        finally:
            with self._recognition_lock:
                self._alignment_workspaces.pop(cancel)

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
        return SeparatedAudio(instrumental, vocal, decode_rhythm(payload.get("rhythm", [])))

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
        start_seconds: float = 0.0,
    ) -> str:
        key = self._recognition_key(vocal, language, cancel, execution, start_seconds)
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
        return self._transcript(payload, key)

    def transcribe_many(
        self,
        requests: Sequence[tuple[Path, float]],
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
        end_seconds: float | None = None,
    ) -> Sequence[str]:
        if not requests:
            return ()
        if self._descriptor.provider_id != "local-torch":
            if end_seconds is not None:
                return ()
            return tuple(
                self.transcribe(audio, language, cancel, execution=execution, start_seconds=start)
                for audio, start in requests
            )
        keys = [
            self._recognition_key(audio, language, cancel, execution, start)
            if end_seconds is None
            else None
            for audio, start in requests
        ]
        payload = self._invoke(
            "transcribe-many",
            ["--language", language.value],
            cancel,
            execution=execution,
            timeout_seconds=self._timeout * len(requests),
            input_data=_transcription_requests(requests, end_seconds),
        )
        values = _transcription_values(payload, len(requests))
        return tuple(self._transcript(value, key) for value, key in zip(values, keys, strict=True))

    def transcribe_window(
        self,
        sources: Sequence[Path],
        start: float,
        end: float,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> Sequence[str]:
        return self.transcribe_many(
            [(source, start) for source in sources],
            language,
            cancel,
            execution=execution,
            end_seconds=end,
        )

    def transcribe_stream(
        self,
        requests: TranscriptionSource,
        request_count: int,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> Sequence[str]:
        if request_count < 0:
            raise ValueError("request_count must be nonnegative")
        if not request_count:
            return ()
        keys: list[_RecognitionKey | None] = []

        def chunks(stopped: threading.Event) -> Iterator[bytes]:
            for audio, start in requests(stopped):
                keys.append(self._recognition_key(audio, language, cancel, execution, start))
                yield (
                    dumps({"requests": [{"input": str(audio), "startSeconds": start}]}) + "\n"
                ).encode("utf-8")

        payload = self._invoke(
            "transcribe-many",
            ["--language", language.value, "--stream-input"],
            cancel,
            execution=execution,
            input_data=chunks,
            timeout_seconds=self._timeout * request_count,
        )
        values = _transcription_values(payload, request_count, "stream")
        if len(keys) != request_count:
            raise DependencyError("AiProviderInvalidOutput", "Transcription stream is malformed")
        return tuple(self._transcript(value, key) for value, key in zip(values, keys, strict=True))

    def _transcript(self, payload: JsonValue, key: _RecognitionKey | None) -> str:
        transcript = _transcription_text(payload)
        if (
            key is not None
            and isinstance(payload, dict)
            and isinstance(payload.get("segments"), list)
        ):
            with self._recognition_lock:
                self._recognitions[key] = (
                    {**payload, "startSeconds": key[-1]} if key[-1] else payload
                )
                if len(self._recognitions) > 4:
                    self._recognitions.pop(next(iter(self._recognitions)))
        return transcript

    def _recognition_key(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        execution: ExecutionContext,
        start_seconds: float = 0.0,
    ) -> _RecognitionKey | None:
        if self._descriptor.provider_id != "local-torch" or not vocal.is_file():
            return None
        return (
            cancel,
            vocal.resolve(),
            language,
            execution.device.value,
            sha256_file(vocal),
            start_seconds,
        )

    def _recognition_for(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        execution: ExecutionContext,
        *,
        with_sources: bool = False,
    ) -> dict[str, JsonValue] | None:
        key = self._recognition_key(vocal, language, cancel, execution)
        with self._recognition_lock:
            recognition = self._recognitions.get(key) if key is not None else None
            cached = list(self._recognitions.items())
        if recognition is None or key is None:
            return None
        alternatives: list[JsonValue] = [
            _source_view(payload, other[4], other[-1]) if with_sources else payload
            for other, payload in cached
            if other != key
            and (other[0], other[2], other[3]) == (key[0], key[2], key[3])
            and self._recognition_key(other[1], language, cancel, execution, other[-1]) == other
        ]
        primary = _source_view(recognition, key[4], key[-1]) if with_sources else recognition
        return {**primary, "alternatives": alternatives}

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
        payload = self._align_payload(
            vocal,
            lyrics,
            language,
            cancel,
            timing_hints=timing_hints,
            execution=execution,
            instrumental=instrumental,
        )
        return _alignment_words(payload)

    def align_transcript(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
        instrumental: Path | None = None,
        baseline_lyrics: str = "",
    ) -> AlignedTranscript:
        if self._descriptor.provider_id != "local-torch":
            return AlignedTranscript(
                lyrics,
                self.align(
                    vocal, lyrics, language, cancel, execution=execution, instrumental=instrumental
                ),
            )
        payload = self._align_payload(
            vocal,
            lyrics,
            language,
            cancel,
            execution=execution,
            instrumental=instrumental,
            asr_lyrics=True,
            baseline_lyrics=baseline_lyrics,
        )
        return AlignedTranscript(
            _text(payload, "lyrics"),
            _alignment_words(payload),
            insertions_verified=payload.get("insertionsVerified") is True,
        )

    def _align_payload(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        timing_hints: Sequence[LyricLineTiming] = (),
        execution: ExecutionContext,
        instrumental: Path | None = None,
        asr_lyrics: bool = False,
        baseline_lyrics: str = "",
    ) -> dict[str, JsonValue]:
        arguments = _alignment_request(
            vocal, lyrics, language, timing_hints, instrumental, asr_lyrics, baseline_lyrics
        )
        arguments.extend(self._alignment_arguments(vocal, cancel))
        recognition = self._recognition_for(
            vocal, language, cancel, execution, with_sources=asr_lyrics
        )
        if recognition is not None:
            arguments.append("--recognition-stdin")
        return self._invoke(
            "align",
            arguments,
            cancel,
            execution=execution,
            input_data=dumps(recognition).encode("utf-8") if recognition is not None else None,
        )

    def _alignment_arguments(self, vocal: Path, cancel: threading.Event) -> list[str]:
        with self._recognition_lock:
            workspace = self._alignment_workspaces.get(cancel)
        if workspace is None or self._budget is None:
            return []
        return [
            "--reuse-directory",
            str(workspace / sha256_file(vocal)),
            "--reuse-reserve",
            str(self._budget.min_free_disk_bytes),
        ]

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]:
        if cancel.is_set():
            raise ConflictError("JobCancelled", "Local processing was cancelled")
        key = (sha256_file(vocal), execution) if vocal.is_file() else None
        if key is not None:
            with self._recognition_lock:
                cached = self._pitch_results.get(key)
                if cached is not None and not cancel.is_set():
                    self._pitch_results.move_to_end(key)
                    return cached
        payload = self._invoke("pitch", ["--input", str(vocal)], cancel, execution=execution)
        values = payload.get("points")
        if not isinstance(values, list):
            raise DependencyError("AiProviderInvalidOutput", "Pitch response is malformed")
        points = tuple(_pitch(value) for value in values)
        if key is not None and len(points) <= 100_000 and not cancel.is_set():
            with self._recognition_lock:
                self._pitch_results[key] = points
                self._pitch_results.move_to_end(key)
                while (
                    len(self._pitch_results) > 8
                    or sum(map(len, self._pitch_results.values())) > 100_000
                ):
                    self._pitch_results.popitem(last=False)
        return points

    def _invoke(
        self,
        action: str,
        arguments: Sequence[str],
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
        input_data: ProcessInput | None = None,
        timeout_seconds: float | None = None,
    ) -> dict[str, JsonValue]:
        try:
            result = self._run_speech(
                action,
                arguments,
                cancel,
                execution,
                input_data,
                self._timeout if timeout_seconds is None else timeout_seconds,
            )
        except DomainError as error:
            if error.code != "ProcessCancelled":
                raise
            raise ConflictError("JobCancelled", "Local AI processing was cancelled") from error
        if result.exit_code != 0:
            logging.getLogger(__name__).error(
                f"Local {action} worker failed: %s",
                result.stderr.decode("utf-8", errors="replace")[-3000:],
            )
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

    def _run_speech(
        self,
        action: str,
        arguments: Sequence[str],
        cancel: threading.Event,
        execution: ExecutionContext,
        input_data: ProcessInput | None,
        timeout_seconds: float,
    ) -> ProcessResult:
        with self._recognition_lock:
            reusable = self._speech_sessions.get(cancel)
        if (
            reusable is not None
            and execution.device is reusable[1]
            and action in ["transcribe", "transcribe-many", "align", "pitch"]
            and not callable(input_data)
            and execution.cpu_fraction is None
        ):
            return reusable[0].run(
                [action, *arguments],
                environment=execution_environment(execution),
                input_data=input_data,
                timeout_seconds=timeout_seconds,
                cancel=cancel,
            )
        else:
            return self._runner.run(
                [*self._command, action, *arguments],
                timeout_seconds=timeout_seconds,
                cancel=cancel,
                input_data=input_data,
                environment=execution_environment(execution),
                cpu_fraction=execution.cpu_fraction,
            )
