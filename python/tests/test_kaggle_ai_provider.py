from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import httpx
import soundfile as sf

import backend.infrastructure.kaggle_ai_provider as kaggle_provider_module
from backend.infrastructure.kaggle_ai_provider import KaggleAiProvider
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.songs.domain import Language


class _Job:
    def __init__(self, value: object) -> None:
        self.value = value

    def done(self) -> bool:
        return True

    def result(self) -> object:
        return self.value

    def cancel(self) -> bool:
        return True


class _Client:
    def __init__(self, instrumental: Path, vocal: Path) -> None:
        self.instrumental = instrumental
        self.vocal = vocal
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    def submit(self, *args: object, api_name: str) -> _Job:
        self.calls.append((api_name, args))
        values: dict[str, object] = {
            "/separate": (str(self.instrumental), str(self.vocal), "a1b2"),
            "/transcribe": "hello",
            "/align": {"words": [{"text": "hello", "start": 0.1, "end": 0.8, "confidence": 1.0, "letters": [0.1, 0.2, 0.3, 0.4, 0.5]}]},
            "/pitch": {"points": [{"time": 0.1, "frequency": 440.0, "confidence": 0.9}]},
        }
        return _Job(values[api_name])


class _Provider(KaggleAiProvider):
    def __init__(self, client: _Client) -> None:
        super().__init__(
            lambda: BackendSettings(
                2,
                compute_mode=ComputeMode.AUTO,
                processing_backend=ProcessingBackend.KAGGLE,
                kaggle_url="https://example.gradio.live",
                kaggle_token="private-token",
            )
        )
        self.client = client

    def _client(self, *, allow_start: bool = True) -> _Client:
        del allow_start
        return self.client

    @staticmethod
    def _handle_file(path: Path) -> str:
        return str(path)


def test_remote_session_reuses_uploaded_vocal_for_later_stages(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    remote_instrumental = tmp_path / "remote-instrumental.wav"
    remote_vocal = tmp_path / "remote-vocal.wav"
    for path, content in (
        (source, b"source"),
        (remote_instrumental, b"instrumental"),
        (remote_vocal, b"vocal"),
    ):
        path.write_bytes(content)
    client = _Client(remote_instrumental, remote_vocal)
    provider = _Provider(client)
    execution = ExecutionContext(ComputeDevice.CPU, 1)
    cancel = threading.Event()

    separated = provider.separate(source, tmp_path / "output", cancel, execution=execution)
    assert provider.transcribe(separated.reference_vocal, Language.ENGLISH, cancel, execution=execution) == "hello"
    words = provider.align(
        separated.reference_vocal,
        "hello",
        Language.ENGLISH,
        cancel,
        execution=execution,
    )
    points = provider.pitch(separated.reference_vocal, cancel, execution=execution)

    assert words[0].letters[-1] == 0.5
    assert points[0].frequency == 440.0
    assert [call[0] for call in client.calls] == ["/separate", "/transcribe", "/align", "/pitch"]
    assert client.calls[1][1][0] == "a1b2"
    assert client.calls[2][1][0] == "a1b2"
    assert client.calls[3][1][0] == "a1b2"


def test_lossless_flac_stems_are_restored_as_pcm_wav(tmp_path: Path) -> None:
    samples = np.array([[0, 1200], [-16000, 16000], [32767, -32768]], dtype=np.int16)
    remote_instrumental = tmp_path / "instrumental.flac"
    remote_vocal = tmp_path / "vocal.flac"
    sf.write(remote_instrumental, samples, 48_000, format="FLAC", subtype="PCM_16")
    sf.write(remote_vocal, samples, 48_000, format="FLAC", subtype="PCM_16")
    provider = _Provider(_Client(remote_instrumental, remote_vocal))

    separated = provider.separate(
        tmp_path / "source.wav",
        tmp_path / "output",
        threading.Event(),
        execution=ExecutionContext(ComputeDevice.CPU, 1),
    )

    restored, sample_rate = sf.read(
        separated.instrumental, dtype="int16", always_2d=True
    )
    assert sample_rate == 48_000
    assert np.array_equal(restored, samples)
    assert separated.instrumental.read_bytes()[:4] == b"RIFF"


def test_kaggle_configuration_validation_connects_to_the_health_checked_client(
    tmp_path: Path,
) -> None:
    client = _Client(tmp_path / "instrumental.wav", tmp_path / "vocal.wav")
    provider = _Provider(client)

    provider.validate_configuration()

    assert provider.client is client


def test_kaggle_health_check_uses_a_short_timeout_before_enabling_long_transfers(
    monkeypatch,
) -> None:
    timeouts: list[object] = []

    class ClientStub:
        def __init__(self, *_args: object, **kwargs: object) -> None:
            timeouts.append(kwargs["httpx_kwargs"]["timeout"])

        def predict(self, *, api_name: str) -> dict[str, int]:
            assert api_name == "/health"
            return {"protocolVersion": 3}

    monkeypatch.setattr(kaggle_provider_module, "Client", ClientStub)
    provider = KaggleAiProvider(
        lambda: BackendSettings(
            2,
            compute_mode=ComputeMode.AUTO,
            processing_backend=ProcessingBackend.KAGGLE,
            kaggle_url="https://example.gradio.live",
            kaggle_token="private-token",
        ),
        discovery_base_url="https://rooms.example",
        discovery_transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )

    provider.validate_configuration()

    assert timeouts == [20, 15 * 60]


def test_current_kaggle_share_url_is_discovered_without_rewriting_settings() -> None:
    requested_headers: list[str] = []

    def discovery(request: httpx.Request) -> httpx.Response:
        requested_headers.append(request.headers["X-AD-Voice-Endpoint-Key"])
        return httpx.Response(200, json={"url": "https://fresh-session.gradio.live"})

    class DiscoveryProvider(KaggleAiProvider):
        connected_url = ""

        def _connect(self, url: str, token: str) -> object:
            self.connected_url = url
            return object()

    provider = DiscoveryProvider(
        lambda: BackendSettings(
            2,
            compute_mode=ComputeMode.AUTO,
            processing_backend=ProcessingBackend.KAGGLE,
            kaggle_url="https://expired-session.gradio.live",
            kaggle_token="private-token",
        ),
        discovery_base_url="https://rooms.example",
        discovery_transport=httpx.MockTransport(discovery),
    )

    provider.validate_configuration()

    assert provider.connected_url == "https://fresh-session.gradio.live"
    assert requested_headers == [
        "eacb9ab8f6db03232e40f809d83464809bdfd41203c70051cc4b42e380732afa"
    ]


def test_processing_a_song_starts_an_idle_kaggle_notebook_automatically() -> None:
    starts: list[str] = []

    class AutoStartingProvider(KaggleAiProvider):
        running = False

        def _discover_url(self, _token: str) -> str | None:
            return "https://fresh-session.gradio.live" if self.running else None

        def _connect(self, url: str, _token: str) -> object:
            assert url == "https://fresh-session.gradio.live"
            return object()

    provider = AutoStartingProvider(
        lambda: BackendSettings(
            2,
            compute_mode=ComputeMode.AUTO,
            processing_backend=ProcessingBackend.KAGGLE,
            kaggle_token="private-token",
        ),
        start_notebook=lambda: (
            starts.append("started"),
            setattr(provider, "running", True),
        ),
    )

    assert provider._client() is not None
    assert starts == ["started"]


def test_configuration_check_does_not_start_an_idle_kaggle_notebook() -> None:
    starts: list[str] = []
    provider = KaggleAiProvider(
        lambda: BackendSettings(
            2,
            compute_mode=ComputeMode.AUTO,
            processing_backend=ProcessingBackend.KAGGLE,
            kaggle_token="private-token",
        ),
        start_notebook=lambda: starts.append("started"),
        discovery_base_url="https://rooms.example",
        discovery_transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )

    try:
        provider.validate_configuration()
    except Exception:
        pass

    assert starts == []
