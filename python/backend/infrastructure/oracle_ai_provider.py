from __future__ import annotations

import contextlib
import os
import tempfile
import threading
import uuid
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path

import httpx
import soundfile as sf

from backend.ai.domain import (
    AiCapability,
    AiProviderDescriptor,
    PitchPoint,
    SeparatedAudio,
    WordTiming,
)
from backend.projects.ports import ProjectStorage
from backend.domain_errors import DependencyError
from backend.infrastructure.command_ai_provider import _number, _pitch, _word
from backend.infrastructure.processing_transport import (
    ProcessingTransport,
    read_bundle,
    write_bundle,
)
from backend.lyrics.codec import decode_rhythm
from backend.lyrics.codec import decode_document
from backend.lyrics.ports import LyricLineTiming
from backend.processing.compute_policy import ExecutionContext
from backend.processing.domain import (
    CompletedProcessingProject,
    ProcessingOptions,
    ProcessingReport,
    StageReport,
    CancellationPolicy,
)
from backend.serialization import JsonValue
from backend.settings.domain import room_server_url, is_secure_kaggle_url
from backend.settings.environment import default_environment_store
from backend.songs.domain import Language, Song
from collections.abc import Callable


def processing_connection() -> tuple[str, str]:
    values = {entry.key: entry.value for entry in default_environment_store().read()}
    token = values.get("AD_VOICE_PROCESSING_TOKEN", "")
    host = values["AD_VOICE_ROOM_SERVER_HOST"].strip()
    port = values["AD_VOICE_ROOM_SERVER_PORT"].strip()
    url = os.environ.get("AD_VOICE_PROCESSING_URL") or room_server_url(host, port) + "/processing"
    if not is_secure_kaggle_url(url) or len(token) < 32:
        raise DependencyError(
            "ProcessingNotConfigured", "Configure the processing access key in ENV settings"
        )
    return url, token


class OracleAiProvider:
    def __init__(self, temp_root: Path, projects: ProjectStorage | None = None) -> None:
        self._temp = temp_root
        self._projects = projects
        self._lock = threading.Lock()
        self._upload_lock = threading.Lock()
        self._sessions: dict[Path, tuple[str, Path | None]] = {}
        self._scopes: dict[threading.Event, str] = {}

    @property
    def descriptor(self) -> AiProviderDescriptor:
        return AiProviderDescriptor(
            "oracle-pc",
            "1",
            frozenset(AiCapability),
            frozenset({"Auto", "Ukrainian", "Russian", "English"}),
            (),
            {"remote": 1, "cpuThreads": 1},
        )

    @contextlib.contextmanager
    def reuse_alignment(self, workdir: Path, cancel: threading.Event) -> Iterator[None]:
        with self._lock:
            self._scopes[cancel] = uuid.uuid4().hex
        try:
            yield
        finally:
            with self._lock:
                self._scopes.pop(cancel, None)

    def validate_configuration(self) -> Mapping[str, object]:
        transport = ProcessingTransport(*processing_connection())
        try:
            health = transport.request("GET", "/health").json()
            if health.get("protocolVersion") != 1:
                raise DependencyError(
                    "ProcessingVersionMismatch", "Processing server must be updated"
                )
            return dict(health)
        except httpx.HTTPError as error:
            raise DependencyError(
                "ProcessingUnavailable", "Could not connect to the processing server"
            ) from error
        finally:
            transport.close()

    def _invoke(
        self,
        action: str,
        options: Mapping[str, object],
        files: Mapping[str, Path],
        cancel: threading.Event,
        output: Path | None = None,
        progress: Callable[[str, float, float], None] | None = None,
    ) -> dict[str, JsonValue]:
        self._temp.mkdir(parents=True, exist_ok=True)
        transport = ProcessingTransport(*processing_connection())
        try:
            with tempfile.TemporaryDirectory(prefix="processing-", dir=self._temp) as temporary:
                directory = Path(temporary)
                request, response = directory / "request.zip", directory / "response.zip"
                write_bundle(request, {"protocolVersion": 1, "action": action, **options}, files)
                transport.invoke(request, response, cancel, progress=progress)
                destination = output or directory
                result = read_bundle(response, destination)
                if result.get("protocolVersion") != 1:
                    raise ValueError("Unsupported processing response")
                return result
        except httpx.HTTPError as error:
            raise DependencyError(
                "ProcessingUnavailable", "Connection to the processing server failed"
            ) from error
        except (ValueError, OSError, KeyError) as error:
            raise DependencyError(
                "AiProviderInvalidOutput", "Remote processing returned invalid output"
            ) from error
        finally:
            transport.close()

    def process_song(
        self,
        song: Song,
        options: ProcessingOptions,
        workdir: Path,
        cancel: threading.Event,
        progress: Callable[[str, float, float], None],
    ) -> CompletedProcessingProject:
        if song.source_path is None:
            raise DependencyError("SourceMissing", "Song source is missing")
        source_name = "source" + song.source_path.suffix.lower()
        files = {source_name: song.source_path}
        previous: Mapping[str, object] | None = None
        if self._projects is not None:
            manifest = self._projects.load_manifest(song.song_id, song.active_revision)
            previous = {
                key: value
                for key, value in manifest.provenance.items()
                if key in ["lyricsSource", "lyricsSourceText", "lyricsTimingHints", "warnings"]
            }
            for name in ["lyricsSync", "lyricsBaseline"]:
                if any(item.logical_name == name for item in manifest.artifacts):
                    files[name + ".json"] = self._projects.artifact_path(
                        song.song_id,
                        song.active_revision,
                        name,
                    )
        progress("DecodeNormalize", 0.0, 0.0)
        result = self._invoke(
            "process-song",
            {
                "session": uuid.uuid4().hex,
                "source": source_name,
                "song": {
                    "title": song.title,
                    "artist": song.artist,
                    "language": song.language.value,
                    "embeddedLyrics": song.embedded_lyrics,
                },
                "mode": options.mode.value,
                "onlineLyrics": options.online_lyrics,
                "previousProvenance": previous,
            },
            files,
            cancel,
            workdir,
            progress,
        )
        failure = result.get("error")
        if isinstance(failure, dict):
            raise DependencyError(
                str(failure.get("code", "ProcessingFailed")),
                str(failure.get("message", "Remote processing failed")),
            )
        raw_report, provenance = result.get("report"), result.get("provenance")
        if not isinstance(raw_report, dict) or not isinstance(provenance, dict):
            raise DependencyError(
                "AiProviderInvalidOutput", "Completed processing project is invalid"
            )
        try:
            stages = raw_report["stages"]
            warnings = raw_report["warnings"]
            if not isinstance(stages, list) or not isinstance(warnings, list):
                raise ValueError("Invalid processing report")
            reports = []
            for item in stages:
                if not isinstance(item, dict):
                    raise ValueError("Invalid processing stage")
                reports.append(
                    StageReport(
                        str(item["stage"]),
                        _number(item, "durationSeconds"),
                        CancellationPolicy(str(item["cancellationPolicy"])),
                    )
                )
            report = ProcessingReport(
                song.song_id,
                song.active_revision,
                tuple(reports),
                {},
                bool(raw_report.get("cacheUsed")),
                tuple(str(value) for value in warnings),
                str(raw_report["algorithmVersion"]),
                processing_backend="Oracle",
            )
            document = decode_document((workdir / "lyrics.json").read_text(encoding="utf-8"))
            return CompletedProcessingProject(
                workdir / "instrumental.flac",
                workdir / "vocals.flac",
                workdir / "melody.flac",
                document,
                provenance,
                report,
            )
        except (KeyError, ValueError, TypeError, OSError) as error:
            raise DependencyError(
                "AiProviderInvalidOutput", "Completed processing project is invalid"
            ) from error

    def separate(
        self, audio: Path, workdir: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> SeparatedAudio:
        session = uuid.uuid4().hex
        workdir.mkdir(parents=True, exist_ok=True)
        result = self._invoke(
            "separate", {"session": session}, {"input.wav": audio}, cancel, workdir
        )
        for name in ["instrumental", "vocals"]:
            compressed = workdir / (name + ".flac")
            samples, rate = sf.read(compressed, dtype="int16", always_2d=True)
            sf.write(workdir / (name + ".wav"), samples, rate, subtype="PCM_16")
            compressed.unlink()
        vocal = workdir / "vocals.wav"
        with self._lock:
            self._sessions[vocal.resolve()] = (session, (workdir / "instrumental.wav").resolve())
        return SeparatedAudio(
            workdir / "instrumental.wav", vocal, decode_rhythm(result.get("rhythm", []))
        )

    def _vocal(
        self,
        action: str,
        vocal: Path,
        options: Mapping[str, object],
        cancel: threading.Event,
        instrumental: Path | None = None,
    ) -> dict[str, JsonValue]:
        # Upload the existing stems once when reprocessing a project or after a worker restart.
        for _ in range(2):
            while not self._upload_lock.acquire(timeout=0.2):
                if cancel.is_set():
                    raise DependencyError("JobCancelled", "Processing was cancelled")
            try:
                with self._lock:
                    session = self._sessions.get(vocal.resolve())
                    scope = self._scopes.get(cancel, "")
                backing = instrumental.resolve() if instrumental is not None else None
                if session is None or (backing is not None and session[1] != backing):
                    files = {"vocals.wav": vocal}
                    if instrumental is not None:
                        files["instrumental.wav"] = instrumental
                    session = (uuid.uuid4().hex, backing)
                    self._invoke("prepare", {"session": session[0]}, files, cancel)
                    with self._lock:
                        self._sessions[vocal.resolve()] = session
            finally:
                self._upload_lock.release()
            result = self._invoke(
                action, {"session": session[0], "scope": scope, **options}, {}, cancel
            )
            if not result.get("sessionExpired"):
                return result
            with self._lock:
                if self._sessions.get(vocal.resolve()) == session:
                    self._sessions.pop(vocal.resolve(), None)
        raise DependencyError(
            "ProcessingSessionExpired", "Processing PC lost the uploaded audio; retry the job"
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
        result = self._vocal(
            "transcribe", vocal, {"language": language.value, "startSeconds": start_seconds}, cancel
        )
        text = result.get("text")
        if not isinstance(text, str):
            raise DependencyError("AiProviderInvalidOutput", "Remote transcription is invalid")
        return text

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
        hints = [{"text": line.text, "start": line.start} for line in timing_hints]
        result = self._vocal(
            "align",
            vocal,
            {"lyrics": lyrics, "language": language.value, "timingHints": hints},
            cancel,
            instrumental,
        )
        words = result.get("words")
        if not isinstance(words, list):
            raise DependencyError("AiProviderInvalidOutput", "Remote alignment is invalid")
        return tuple(_word(value) for value in words)

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]:
        points = self._vocal("pitch", vocal, {}, cancel).get("points")
        if not isinstance(points, list):
            raise DependencyError("AiProviderInvalidOutput", "Remote pitch response is invalid")
        return tuple(_pitch(value) for value in points)
