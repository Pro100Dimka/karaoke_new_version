from __future__ import annotations

import hashlib
import os
import shutil
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import CancelledError
from contextlib import AbstractContextManager
from pathlib import Path

import httpx
import soundfile as sf
from gradio_client import Client, handle_file

from backend.ai.domain import (
    AiCapability,
    AiProviderDescriptor,
    PitchPoint,
    SeparatedAudio,
    WordTiming,
)
from backend.ai.ports import AiProvider
from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.infrastructure.kaggle_notebook_automation import KaggleNotebookAutomation
from backend.infrastructure.kaggle_alignment import (
    CLIENT_ERRORS as _CLIENT_ERRORS,
    AlignmentScopes,
    alignment_scope,
    invocation_error,
)
from backend.lyrics.ports import LyricLineTiming
from backend.lyrics.codec import decode_rhythm
from backend.processing.compute_policy import ExecutionContext
from backend.serialization import dumps, loads_object
from backend.settings.domain import BackendSettings, ProcessingBackend, is_secure_kaggle_url
from backend.songs.domain import Language

_PROVIDER_ID = "kaggle-p100"
_PROTOCOL_VERSION = 7
_HEALTH_TIMEOUT_SECONDS = 20
_TRANSFER_TIMEOUT_SECONDS = 15 * 60
_STARTUP_TIMEOUT_SECONDS = 15 * 60
_STARTUP_POLL_SECONDS = 5


def _room_server_base_url() -> str:
    host = os.getenv("AD_VOICE_ROOM_SERVER_HOST")
    port = os.getenv("AD_VOICE_ROOM_SERVER_PORT")
    if host or port:
        return f"http://{host or '130.61.169.61'}:{port or '8081'}"
    return os.getenv("AD_VOICE_ROOM_SERVER") or "http://130.61.169.61:8081"


class KaggleAiProvider(AiProvider):
    """Authenticated Gradio client; an opaque session reuses the uploaded vocal for alignment/pitch."""

    def __init__(
        self,
        settings: Callable[[], BackendSettings],
        *,
        discovery_base_url: str | None = None,
        discovery_transport: httpx.BaseTransport | None = None,
        start_notebook: Callable[[threading.Event], None] | None = None,
    ) -> None:
        self._settings = settings
        self._discovery_base_url = (
            discovery_base_url
            or os.getenv("AD_VOICE_KAGGLE_DISCOVERY_URL")
            or _room_server_base_url()
        ).rstrip("/")
        self._discovery_transport = discovery_transport
        self._start_notebook = start_notebook
        self._notebook = KaggleNotebookAutomation()
        self._descriptor = AiProviderDescriptor(
            provider_id=_PROVIDER_ID,
            version="1",
            capabilities=frozenset(AiCapability),
            supported_languages=frozenset({"Auto", "Ukrainian", "Russian", "English"}),
            required_models=(),
            required_resources={"remote": 1, "cpuThreads": 1},
        )
        self._lock = threading.Lock()
        self._startup_lock = threading.Lock()
        self._session_lock = threading.Lock()
        self._sessions: dict[Path, tuple[str, Path | None]] = {}
        self._clients: dict[tuple[str, str], Client] = {}
        self._health_clients: dict[tuple[str, str], Client] = {}
        self._session_generation: tuple[str, str, str] | None = None
        self._alignment_scopes: AlignmentScopes = {}

    @property
    def descriptor(self) -> AiProviderDescriptor:
        return self._descriptor

    def reuse_alignment(
        self, workdir: Path, cancel: threading.Event
    ) -> AbstractContextManager[None]:
        del workdir
        return alignment_scope(self._alignment_scopes, self._lock, cancel)

    def validate_configuration(self) -> None:
        """Connect and execute the notebook health check without starting a processing job."""
        self._client(allow_start=False)

    def shutdown(self) -> None:
        """Ask an available notebook to end its Kaggle session without starting it."""
        try:
            settings = self._settings()
            token = settings.kaggle_token or ""
            url = (self._discover_url(token) or settings.kaggle_url) if token else None
            if not url or not is_secure_kaggle_url(url):
                return
            client = Client(
                url,
                auth=("advoice", token),
                verbose=False,
                httpx_kwargs={"timeout": _HEALTH_TIMEOUT_SECONDS},
            )
            client.predict(api_name="/shutdown")
        except (AttributeError, CancelledError, DependencyError, *_CLIENT_ERRORS):
            pass
        finally:
            with self._lock:
                self._clients.clear()
                self._health_clients.clear()
                self._sessions.clear()
                self._session_generation = None

    def separate(
        self, audio: Path, workdir: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> SeparatedAudio:
        result = self._invoke("/separate", cancel, self._handle_file(audio))
        if not isinstance(result, (tuple, list)) or len(result) not in {3, 4}:
            raise self._invalid("Separation response is malformed")
        workdir.mkdir(parents=True, exist_ok=True)
        instrumental, vocal = workdir / "instrumental.wav", workdir / "vocals.wav"
        self._restore_stem(result[0], instrumental)
        self._restore_stem(result[1], vocal)
        session_id = str(result[2]).strip()
        if not session_id:
            raise self._invalid("Separation response has no remote session id")
        with self._lock:
            self._sessions[vocal.resolve()] = (session_id, instrumental.resolve())
        rhythm = decode_rhythm(result[3]) if len(result) == 4 else ()
        return SeparatedAudio(instrumental, vocal, rhythm)

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
        start_seconds: float = 0.0,
    ) -> str:
        arguments = (language.value, start_seconds) if start_seconds else (language.value,)
        result = self._invoke_vocal("/transcribe", vocal, cancel, *arguments)
        if not isinstance(result, str):
            raise self._invalid("Transcription response is malformed")
        return result

    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
        *,
        timing_hints: Sequence[LyricLineTiming] = (),
        instrumental: Path | None = None,
        execution: ExecutionContext,
    ) -> Sequence[WordTiming]:
        hints = dumps([{"start": hint.start, "text": hint.text} for hint in timing_hints])
        arguments = [lyrics, language.value, hints]
        with self._lock:
            scope = self._alignment_scopes.get(cancel)
        if scope is not None:
            arguments.append(scope[0])
        result = self._json_result(
            self._invoke_vocal("/align", vocal, cancel, *arguments, instrumental=instrumental)
        )
        values = result.get("words")
        if not isinstance(values, list):
            raise self._invalid("Alignment response is malformed")
        return tuple(self._word(value) for value in values)

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]:
        del execution
        result = self._json_result(self._invoke_vocal("/pitch", vocal, cancel))
        values = result.get("points")
        if not isinstance(values, list):
            raise self._invalid("Pitch response is malformed")
        return tuple(self._pitch(value) for value in values)

    def _invoke(
        self,
        api_name: str,
        cancel: threading.Event,
        *arguments: object,
        client: Client | None = None,
    ) -> object:
        _ensure_not_cancelled(cancel)
        try:
            client = client if client is not None else self._client(cancel=cancel)
            with self._lock:
                scope = self._alignment_scopes.get(cancel) if api_name == "/align" else None
                if scope is not None:
                    scope[1][str(arguments[0])] = client
            _ensure_not_cancelled(cancel)
            job = client.submit(*arguments, api_name=api_name)
            while not job.done():
                if cancel.wait(0.2):
                    job.cancel()
                    _ensure_not_cancelled(cancel)
            _ensure_not_cancelled(cancel)
            return job.result()
        except DomainError:
            _ensure_not_cancelled(cancel)
            raise
        except _CLIENT_ERRORS as exc:
            _ensure_not_cancelled(cancel)
            raise invocation_error(exc, _PROVIDER_ID) from exc

    def _invoke_vocal(
        self,
        api_name: str,
        vocal: Path,
        cancel: threading.Event,
        *arguments: object,
        instrumental: Path | None = None,
    ) -> object:
        session, client = self._session(vocal, cancel, instrumental)
        try:
            return self._invoke(api_name, cancel, session, *arguments, client=client)
        except DependencyError as error:
            if error.code != "KaggleSessionExpired":
                raise
        with self._lock:
            cached = self._sessions.get(vocal.resolve())
            if cached is not None and cached[0] == session:
                self._sessions.pop(vocal.resolve())
        session, client = self._session(vocal, cancel, instrumental)
        return self._invoke(api_name, cancel, session, *arguments, client=client)

    def _client(self, *, allow_start: bool = True, cancel: threading.Event | None = None) -> Client:
        settings = self._settings()
        token = settings.kaggle_token or ""
        if not token:
            raise DependencyError(
                "KaggleNotConfigured",
                "Kaggle access token must be configured in Settings",
            )
        try:
            return self._available_client(settings, token)
        except DependencyError:
            if (
                not allow_start
                or self._start_notebook is None
                or settings.processing_backend is not ProcessingBackend.KAGGLE
            ):
                raise
            return self._start_and_wait(settings, token, cancel or threading.Event())

    def _available_client(self, settings: BackendSettings, token: str) -> Client:
        url = self._discover_url(token) or (settings.kaggle_url or "").strip().rstrip("/")
        if not url:
            raise DependencyError(
                "KaggleNotRunning",
                "Start the Kaggle notebook; its current address will be detected automatically",
            )
        if not is_secure_kaggle_url(url):
            raise DependencyError("KaggleUrlInvalid", "Kaggle URL must use HTTPS")
        key = (url, token)
        client = self._connect(url, token)
        with self._lock:
            self._clients = {key: client}
        return client

    def _start_and_wait(
        self,
        settings: BackendSettings,
        token: str,
        cancel: threading.Event,
    ) -> Client:
        while not self._startup_lock.acquire(timeout=0.2):
            _ensure_not_cancelled(cancel)
        try:
            _ensure_not_cancelled(cancel)
            try:
                return self._available_client(settings, token)
            except DependencyError as error:
                if error.code == "KaggleProtocolMismatch":
                    self.shutdown()
            assert self._start_notebook is not None
            self._start_notebook(cancel)
            deadline = time.monotonic() + _STARTUP_TIMEOUT_SECONDS
            while True:
                _ensure_not_cancelled(cancel)
                try:
                    return self._available_client(settings, token)
                except DependencyError as error:
                    if time.monotonic() >= deadline:
                        raise DependencyError(
                            "KaggleNotebookStartupTimeout",
                            "Kaggle notebook did not become ready in time",
                        ) from error
                    cancel.wait(_STARTUP_POLL_SECONDS)
        finally:
            self._startup_lock.release()

    def _discover_url(self, token: str) -> str | None:
        try:
            with httpx.Client(
                transport=self._discovery_transport,
                timeout=5.0,
            ) as client:
                response = client.get(
                    f"{self._discovery_base_url}/kaggle/endpoint",
                    headers={
                        "X-AD-Voice-Endpoint-Key": hashlib.sha256(token.encode("utf-8")).hexdigest()
                    },
                )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            url = str(response.json().get("url", "")).strip().rstrip("/")
            return url if url.startswith("https://") else None
        except (httpx.HTTPError, TypeError, ValueError):
            return None

    def _connect(self, url: str, token: str) -> Client:
        try:
            # Full-song lossless transfers through the tunnel exceed Gradio's default HTTP timeout.
            generation = (url, token, self._health_generation(url, token))
            with self._lock:
                if self._session_generation != generation:
                    self._sessions.clear()
                    self._clients.clear()
                    self._session_generation = generation
                cached = self._clients.get((url, token))
            if cached is not None:
                return cached
            return Client(
                url,
                auth=("advoice", token),
                verbose=False,
                httpx_kwargs={"timeout": _TRANSFER_TIMEOUT_SECONDS},
            )
        except DependencyError:
            raise
        except _CLIENT_ERRORS as exc:
            raise DependencyError(
                "KaggleUnavailable", "Could not connect to the Kaggle notebook"
            ) from exc

    def _health_generation(self, url: str, token: str) -> str:
        with self._lock:
            probe = self._health_clients.get((url, token))
        if probe is None:
            probe = Client(
                url,
                auth=("advoice", token),
                verbose=False,
                httpx_kwargs={"timeout": _HEALTH_TIMEOUT_SECONDS},
            )
        try:
            health = self._json_result(probe.predict(api_name="/health"))
        except _CLIENT_ERRORS:
            with self._lock:
                self._health_clients.pop((url, token), None)
            raise
        generation = health.get("sessionGeneration")
        if (
            health.get("protocolVersion") != _PROTOCOL_VERSION
            or health.get("workerRevision") != self._notebook.revision
            or not isinstance(generation, str)
            or not generation
        ):
            raise DependencyError("KaggleProtocolMismatch", "Kaggle worker does not match this app")
        with self._lock:
            self._health_clients = {(url, token): probe}
        return generation

    @staticmethod
    def _handle_file(path: Path) -> object:
        try:
            return handle_file(str(path))
        except (OSError, RuntimeError, ValueError) as exc:
            raise DependencyError(
                "KaggleClientUnavailable", "Gradio client is not installed"
            ) from exc

    def _session(
        self, vocal: Path, cancel: threading.Event, instrumental: Path | None = None
    ) -> tuple[str, Client]:
        _ensure_not_cancelled(cancel)
        while not self._session_lock.acquire(timeout=0.2):
            _ensure_not_cancelled(cancel)
        try:
            _ensure_not_cancelled(cancel)
            client = self._client(cancel=cancel)
            backing = instrumental.resolve() if instrumental is not None else None
            with self._lock:
                session = self._sessions.get(vocal.resolve())
            if session is None or (backing is not None and session[1] != backing):
                uploaded = self._invoke(
                    "/prepare_vocal",
                    cancel,
                    self._handle_file(vocal),
                    self._handle_file(instrumental) if instrumental else None,
                    client=client,
                )
                if not isinstance(uploaded, str) or not uploaded.strip():
                    raise self._invalid("Vocal upload response has no remote session id")
                session = (uploaded.strip(), backing)
                with self._lock:
                    self._sessions[vocal.resolve()] = session
            return session[0], client
        finally:
            self._session_lock.release()

    @staticmethod
    def _file_path(value: object) -> Path:
        location = value.get("path") if isinstance(value, Mapping) else value
        if not isinstance(location, str):
            raise KaggleAiProvider._invalid("Remote audio output is malformed")
        path = Path(location)
        if not path.is_file():
            raise KaggleAiProvider._invalid("Remote audio output is missing")
        return path

    @staticmethod
    def _restore_stem(value: object, destination: Path) -> None:
        source = KaggleAiProvider._file_path(value)
        if source.suffix.casefold() != ".flac":
            shutil.copyfile(source, destination)
            return
        samples, sample_rate = sf.read(source, dtype="int16", always_2d=True)
        sf.write(destination, samples, sample_rate, format="WAV", subtype="PCM_16")

    @staticmethod
    def _json_result(value: object) -> Mapping[str, object]:
        if isinstance(value, str):
            try:
                value = loads_object(value)
            except ValueError as exc:
                raise KaggleAiProvider._invalid("Remote JSON output is malformed") from exc
        if not isinstance(value, Mapping):
            raise KaggleAiProvider._invalid("Remote JSON output is malformed")
        return value

    @staticmethod
    def _word(value: object) -> WordTiming:
        if not isinstance(value, Mapping):
            raise KaggleAiProvider._invalid("Alignment item is malformed")
        letters = value.get("letters", [])
        if not isinstance(letters, list):
            letters = []
        diagnostics = value.get("diagnostics", [])
        return WordTiming(
            str(value["text"]),
            float(value["start"]),
            float(value["end"]),
            float(value["confidence"]),
            tuple(float(item) for item in letters),
            tuple(item for item in diagnostics if isinstance(item, str))
            if isinstance(diagnostics, list)
            else (),
        )

    @staticmethod
    def _pitch(value: object) -> PitchPoint:
        if not isinstance(value, Mapping):
            raise KaggleAiProvider._invalid("Pitch item is malformed")
        active = value.get("audioActive")
        return PitchPoint(
            float(value["time"]),
            float(value["frequency"]),
            float(value["confidence"]),
            active if isinstance(active, bool) else None,
        )

    @staticmethod
    def _invalid(message: str) -> DependencyError:
        return DependencyError("AiProviderInvalidOutput", message, providerId=_PROVIDER_ID)


def _ensure_not_cancelled(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise ConflictError("JobCancelled", "Kaggle processing was cancelled")
