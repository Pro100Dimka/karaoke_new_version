from __future__ import annotations

import shutil
import threading
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import httpx
import soundfile as sf
from gradio_client import Client, handle_file
from gradio_client.exceptions import (
    AppError,
    AuthenticationError,
    SerializationSetupError,
    ValidationError as GradioValidationError,
)

from backend.ai.domain import AiCapability, AiProviderDescriptor, PitchPoint, SeparatedAudio, WordTiming
from backend.ai.ports import AiProvider
from backend.domain_errors import DependencyError
from backend.lyrics.ports import LyricLineTiming
from backend.processing.compute_policy import ExecutionContext
from backend.serialization import dumps, loads_object
from backend.settings.domain import BackendSettings
from backend.songs.domain import Language

_PROVIDER_ID = "kaggle-p100"
_PROTOCOL_VERSION = 2
_TRANSFER_TIMEOUT_SECONDS = 15 * 60


class KaggleAiProvider(AiProvider):
    """Calls the user's private Kaggle notebook through its authenticated Gradio API.

    Separation uploads the source once. The notebook keeps the vocal under an opaque
    session id, so alignment and pitch do not upload that large file again.
    """

    def __init__(self, settings: Callable[[], BackendSettings]) -> None:
        self._settings = settings
        self._descriptor = AiProviderDescriptor(
            provider_id=_PROVIDER_ID,
            version="1",
            capabilities=frozenset(AiCapability),
            supported_languages=frozenset({"Auto", "Ukrainian", "Russian", "English"}),
            required_models=(),
            required_resources={"remote": 1, "cpuThreads": 1},
        )
        self._lock = threading.Lock()
        self._sessions: dict[Path, str] = {}
        self._clients: dict[tuple[str, str], Client] = {}

    @property
    def descriptor(self) -> AiProviderDescriptor:
        return self._descriptor

    def separate(
        self, audio: Path, workdir: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> SeparatedAudio:
        del execution
        result = self._invoke("/separate", cancel, self._handle_file(audio))
        if not isinstance(result, (tuple, list)) or len(result) != 3:
            raise self._invalid("Separation response is malformed")
        workdir.mkdir(parents=True, exist_ok=True)
        instrumental = workdir / "instrumental.wav"
        vocal = workdir / "vocals.wav"
        self._restore_stem(result[0], instrumental)
        self._restore_stem(result[1], vocal)
        session_id = str(result[2]).strip()
        if not session_id:
            raise self._invalid("Separation response has no remote session id")
        with self._lock:
            self._sessions[vocal.resolve()] = session_id
        return SeparatedAudio(instrumental, vocal)

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
        *,
        execution: ExecutionContext,
    ) -> str:
        del execution
        result = self._invoke("/transcribe", cancel, self._session(vocal), language.value)
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
        execution: ExecutionContext,
    ) -> Sequence[WordTiming]:
        del execution
        hints = dumps([{"start": hint.start, "text": hint.text} for hint in timing_hints])
        result = self._json_result(
            self._invoke(
                "/align", cancel, self._session(vocal), lyrics, language.value, hints
            )
        )
        values = result.get("words")
        if not isinstance(values, list):
            raise self._invalid("Alignment response is malformed")
        return tuple(self._word(value) for value in values)

    def pitch(
        self, vocal: Path, cancel: threading.Event, *, execution: ExecutionContext
    ) -> Sequence[PitchPoint]:
        del execution
        result = self._json_result(self._invoke("/pitch", cancel, self._session(vocal)))
        values = result.get("points")
        if not isinstance(values, list):
            raise self._invalid("Pitch response is malformed")
        return tuple(self._pitch(value) for value in values)

    def _invoke(self, api_name: str, cancel: threading.Event, *arguments: object) -> object:
        client = self._client()
        try:
            job = client.submit(*arguments, api_name=api_name)
            while not job.done():
                if cancel.wait(0.2):
                    job.cancel()
                    raise DependencyError("AiProviderCancelled", "Kaggle processing was cancelled")
            return job.result()
        except DependencyError:
            raise
        except (
            AppError,
            AuthenticationError,
            GradioValidationError,
            SerializationSetupError,
            httpx.HTTPError,
            OSError,
            RuntimeError,
            ValueError,
        ) as exc:
            raise DependencyError(
                "KaggleUnavailable",
                "Kaggle GPU notebook is unavailable. Start the notebook and update its URL in Settings.",
                providerId=_PROVIDER_ID,
                reason=type(exc).__name__,
            ) from exc

    def _client(self) -> Client:
        settings = self._settings()
        url = (settings.kaggle_url or "").strip().rstrip("/")
        token = settings.kaggle_token or ""
        if not url or not token:
            raise DependencyError(
                "KaggleNotConfigured",
                "Kaggle URL and access token must be configured in Settings",
            )
        if not (url.startswith("https://") or url.startswith("http://127.0.0.1")):
            raise DependencyError("KaggleUrlInvalid", "Kaggle URL must use HTTPS")
        key = (url, token)
        with self._lock:
            cached = self._clients.get(key)
            if cached is not None:
                return cached
        client = self._connect(url, token)
        with self._lock:
            self._clients = {key: client}
        return client

    def _connect(self, url: str, token: str) -> Client:
        try:
            # Gradio's default HTTP timeout is too short for uploading a full song or
            # downloading two lossless WAV stems over a share tunnel. The queued GPU
            # call itself is asynchronous, but its file transfers use this timeout.
            client = Client(
                url,
                auth=("advoice", token),
                verbose=False,
                httpx_kwargs={"timeout": _TRANSFER_TIMEOUT_SECONDS},
            )
            health = self._json_result(client.predict(api_name="/health"))
            if health.get("protocolVersion") != _PROTOCOL_VERSION:
                raise DependencyError(
                    "KaggleProtocolMismatch",
                    "The Kaggle notebook version does not match this application",
                )
            return client
        except DependencyError:
            raise
        except (
            AppError,
            AuthenticationError,
            GradioValidationError,
            SerializationSetupError,
            httpx.HTTPError,
            OSError,
            RuntimeError,
            ValueError,
        ) as exc:
            raise DependencyError(
                "KaggleUnavailable", "Could not connect to the Kaggle notebook"
            ) from exc

    @staticmethod
    def _handle_file(path: Path) -> object:
        try:
            return handle_file(str(path))
        except (OSError, RuntimeError, ValueError) as exc:
            raise DependencyError("KaggleClientUnavailable", "Gradio client is not installed") from exc

    def _session(self, vocal: Path) -> str:
        with self._lock:
            session = self._sessions.get(vocal.resolve())
        if session is None:
            raise self._invalid("Remote session for the separated vocal was lost")
        return session

    @staticmethod
    def _file_path(value: object) -> Path:
        if isinstance(value, str):
            path = Path(value)
        elif isinstance(value, Mapping) and isinstance(value.get("path"), str):
            path = Path(value["path"])
        else:
            raise KaggleAiProvider._invalid("Remote audio output is malformed")
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
        return WordTiming(
            str(value["text"]),
            float(value["start"]),
            float(value["end"]),
            float(value["confidence"]),
            tuple(float(item) for item in letters),
        )

    @staticmethod
    def _pitch(value: object) -> PitchPoint:
        if not isinstance(value, Mapping):
            raise KaggleAiProvider._invalid("Pitch item is malformed")
        return PitchPoint(
            float(value["time"]), float(value["frequency"]), float(value["confidence"])
        )

    @staticmethod
    def _invalid(message: str) -> DependencyError:
        return DependencyError("AiProviderInvalidOutput", message, providerId=_PROVIDER_ID)
