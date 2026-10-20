from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import httpx
import soundfile as sf
import pytest

import backend.infrastructure.kaggle_ai_provider as kaggle_provider_module
from backend.infrastructure.kaggle_ai_provider import KaggleAiProvider
from backend.models.domain import ComputeMode
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.songs.domain import Language
from backend.domain_errors import DomainError, DependencyError


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
            "/prepare_vocal": "b2c3",
            "/transcribe": "hello",
            "/align": {
                "words": [
                    {
                        "text": "hello",
                        "start": 0.1,
                        "end": 0.8,
                        "confidence": 1.0,
                        "letters": [0.1, 0.2, 0.3, 0.4, 0.5],
                    }
                ]
            },
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

    def _client(
        self, *, allow_start: bool = True, cancel: threading.Event | None = None
    ) -> _Client:
        del allow_start, cancel
        return self.client

    @staticmethod
    def _handle_file(path: Path) -> str:
        return str(path)


@pytest.mark.parametrize("activity", [True, False, None])
def test_remote_pitch_preserves_optional_audio_activity(activity) -> None:
    value = {"time": 0.1, "frequency": 440.0, "confidence": 0.1}
    if activity is not None:
        value["audioActive"] = activity
    assert KaggleAiProvider._pitch(value).audio_active is activity


@pytest.mark.parametrize("diagnostics", [[], ["AsrCtcBoundaryDisagreement"]])
def test_remote_alignment_preserves_optional_word_diagnostics(diagnostics) -> None:
    word = KaggleAiProvider._word({
        "text": "la", "start": 1.0, "end": 1.5, "confidence": 0.8,
        "diagnostics": diagnostics,
    })

    assert word.diagnostics == tuple(diagnostics)


def test_cancelled_kaggle_call_never_submits_remote_work(tmp_path: Path) -> None:
    client = _Client(tmp_path / "instrumental.wav", tmp_path / "vocal.wav")
    provider = _Provider(client)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(DomainError, match="cancel"):
        provider._invoke("/transcribe", cancel)
    assert client.calls == []


@pytest.mark.parametrize("process_cancelled", [False, True])
def test_kaggle_cancellation_during_startup_skips_polling_and_submission(
    monkeypatch, process_cancelled
) -> None:
    cancel = threading.Event()
    attempts = 0

    class OfflineProvider(KaggleAiProvider):
        def _available_client(self, *args):
            nonlocal attempts
            attempts += 1
            if attempts > 2:
                raise AssertionError("must not poll after startup cancellation")
            raise DependencyError("Offline", "not running")

    def start(_cancel):
        cancel.set()
        if process_cancelled:
            raise DomainError("ProcessCancelled", "External process was cancelled", 499)

    provider = OfflineProvider(
        lambda: BackendSettings(
            2, processing_backend=ProcessingBackend.KAGGLE, kaggle_token="test"
        ),
        start_notebook=start,
    )
    monkeypatch.setattr(
        kaggle_provider_module.time, "sleep", lambda _seconds: pytest.fail("uncancellable sleep")
    )
    with pytest.raises(DomainError, match="cancel") as raised:
        provider._invoke("/transcribe", cancel)
    assert raised.value.code == "JobCancelled"


@pytest.mark.parametrize("waiting_for_lock", [False, True])
def test_kaggle_startup_waits_release_promptly_when_cancelled(monkeypatch, waiting_for_lock):
    entered, done = threading.Event(), threading.Event()
    errors = []

    class ObservedCancellation(threading.Event):
        def wait(self, timeout=None):
            if timeout == 30:
                entered.set()
            return super().wait(timeout)

    cancel = ObservedCancellation()

    class OfflineProvider(KaggleAiProvider):
        def _available_client(self, *args):
            if waiting_for_lock:
                entered.set()
            raise DependencyError("Offline", "not running")

    provider = OfflineProvider(
        lambda: BackendSettings(
            2, processing_backend=ProcessingBackend.KAGGLE, kaggle_token="test"
        ),
        start_notebook=lambda _cancel: None,
    )
    monkeypatch.setattr(kaggle_provider_module, "_STARTUP_POLL_SECONDS", 30)

    def invoke():
        try:
            provider._invoke("/transcribe", cancel)
        except DomainError as error:
            errors.append(error.code)
        finally:
            done.set()

    if waiting_for_lock:
        provider._startup_lock.acquire()
    worker = threading.Thread(target=invoke)
    worker.start()
    try:
        assert entered.wait(1)
        cancel.set()
        assert done.wait(1), "cancel must interrupt lock or long polling wait"
    finally:
        if waiting_for_lock:
            provider._startup_lock.release()
        cancel.set()
        worker.join(1)
    assert errors == ["JobCancelled"]


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
    assert (
        provider.transcribe(
            separated.reference_vocal, Language.ENGLISH, cancel, execution=execution
        )
        == "hello"
    )
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


def test_existing_vocal_is_uploaded_once_and_reused_for_alignment_and_pitch(tmp_path: Path) -> None:
    vocal = tmp_path / "existing-vocal.wav"
    vocal.write_bytes(b"existing project vocal")
    client = _Client(tmp_path / "unused.wav", tmp_path / "unused-vocal.wav")
    provider = _Provider(client)
    execution = ExecutionContext(ComputeDevice.CPU, 1)
    cancel = threading.Event()

    provider.align(vocal, "hello", Language.ENGLISH, cancel, execution=execution)
    provider.pitch(vocal, cancel, execution=execution)

    assert [name for name, _args in client.calls] == ["/prepare_vocal", "/align", "/pitch"]
    assert client.calls[0][1] == (str(vocal),)
    assert client.calls[1][1][0] == client.calls[2][1][0] == "b2c3"
    assert vocal.read_bytes() == b"existing project vocal"


@pytest.mark.parametrize("change", ["generation", "url", "token"])
def test_vocal_session_cache_is_bound_to_the_live_notebook(tmp_path, monkeypatch, change):
    from gradio_client.exceptions import AppError

    state = {"generation": "first", "url": "https://first.gradio.live", "token": "token-one"}
    calls, probes = [], []

    class Notebook:
        def __init__(self, *_args, **_kwargs):
            pass

        def predict(self, *, api_name):
            assert api_name == "/health"
            probes.append(tuple(state.values()))
            return {"protocolVersion": 4, "sessionGeneration": state["generation"]}

        def submit(self, *args, api_name):
            calls.append((api_name, args))
            session = "a" * 32 if len(set(probes)) == 1 else "b" * 32
            if api_name == "/prepare_vocal":
                return _Job(session)
            if args[0] != session:
                raise AppError('{"code":"KaggleSessionExpired"}')
            return _Job({"points": [{"time": 0.1, "frequency": 440, "confidence": 0.9}]})

    monkeypatch.setattr(kaggle_provider_module, "Client", Notebook)
    provider = KaggleAiProvider(
        lambda: BackendSettings(
            2, processing_backend=ProcessingBackend.KAGGLE,
            kaggle_url=state["url"], kaggle_token=state["token"]
        ), discovery_transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )
    monkeypatch.setattr(provider, "_handle_file", str)
    vocal = tmp_path / "vocal.wav"
    provider.pitch(vocal, threading.Event(), execution=ExecutionContext(ComputeDevice.CPU, 1))
    state[change] = {"generation": "second", "url": "https://second.gradio.live", "token": "token-two"}[change]

    provider.pitch(vocal, threading.Event(), execution=ExecutionContext(ComputeDevice.CPU, 1))

    assert [name for name, _args in calls] == ["/prepare_vocal", "/pitch", "/prepare_vocal", "/pitch"]
    assert calls[-1][1][0] == "b" * 32
    assert len(set(probes)) == 2


@pytest.mark.parametrize("expires_twice", [False, True])
def test_expired_vocal_session_is_reuploaded_at_most_once(tmp_path, expires_twice):
    from gradio_client.exceptions import AppError

    class ExpiringClient(_Client):
        def submit(self, *args, api_name):
            if api_name == "/pitch" and (args[0] == "expired" or expires_twice):
                self.calls.append((api_name, args))
                raise AppError('{"code":"KaggleSessionExpired"}')
            return super().submit(*args, api_name=api_name)

    client = ExpiringClient(tmp_path / "unused.wav", tmp_path / "unused-vocal.wav")
    provider = _Provider(client)
    vocal = tmp_path / "vocal.wav"
    provider._sessions[vocal.resolve()] = "expired"
    def invoke():
        return provider.pitch(vocal, threading.Event(), execution=ExecutionContext(ComputeDevice.CPU, 1))
    if expires_twice:
        with pytest.raises(DependencyError) as error:
            invoke()
        assert error.value.code == "KaggleSessionExpired"
    else:
        assert invoke()[0].frequency == 440
    assert [name for name, _args in client.calls] == ["/pitch", "/prepare_vocal", "/pitch"]


def test_shutdown_discards_cached_vocal_sessions(tmp_path):
    provider = KaggleAiProvider(
        lambda: BackendSettings(2),
        discovery_transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )
    provider._sessions[tmp_path / "vocal.wav"] = "expired"
    provider.shutdown()
    assert provider._sessions == {}


def test_unrelated_remote_errors_do_not_reupload_the_vocal(tmp_path):
    from gradio_client.exceptions import AppError

    class FailedClient(_Client):
        def submit(self, *args, api_name):
            self.calls.append((api_name, args))
            raise AppError("ordinary remote failure")

    client = FailedClient(tmp_path / "unused.wav", tmp_path / "unused-vocal.wav")
    provider = _Provider(client)
    vocal = tmp_path / "vocal.wav"
    provider._sessions[vocal.resolve()] = "cached"
    with pytest.raises(DependencyError) as error:
        provider.pitch(vocal, threading.Event(), execution=ExecutionContext(ComputeDevice.CPU, 1))
    assert error.value.code == "KaggleUnavailable"
    assert [name for name, _args in client.calls] == ["/pitch"]


def test_cancellation_interrupts_waiting_for_an_existing_vocal_upload(tmp_path, monkeypatch):
    provider = _Provider(_Client(tmp_path / "unused.wav", tmp_path / "unused-vocal.wav"))
    cancel, entered, done = threading.Event(), threading.Event(), threading.Event()
    errors = []
    original = kaggle_provider_module._ensure_not_cancelled

    def observe(token):
        original(token)
        entered.set()

    monkeypatch.setattr(kaggle_provider_module, "_ensure_not_cancelled", observe)

    def invoke():
        try:
            provider.pitch(tmp_path / "vocal.wav", cancel, execution=ExecutionContext(ComputeDevice.CPU, 1))
        except DomainError as error:
            errors.append(error.code)
        finally:
            done.set()

    provider._session_lock.acquire()
    worker = threading.Thread(target=invoke)
    worker.start()
    try:
        assert entered.wait(1)
        cancel.set()
        assert done.wait(1), "Vocal-upload lock waiting must remain cancellable"
    finally:
        provider._session_lock.release()
        worker.join(1)
    assert errors == ["JobCancelled"]
    assert provider.client.calls == []


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

    restored, sample_rate = sf.read(separated.instrumental, dtype="int16", always_2d=True)
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


@pytest.mark.parametrize(
    ("url", "allowed"),
    [
        ("https://example.gradio.live", True),
        ("http://127.0.0.1:7860/api", True),
        ("http://127.0.0.1", True),
        ("http://127.0.0.1.example.invalid", False),
        ("http://127.0.0.1@remote.example.invalid", False),
        ("http://127.0.0.10", False),
        ("http://localhost:7860", False),
        ("https:///missing-host", False),
        ("https://[invalid", False),
    ],
)
def test_kaggle_credentials_require_https_or_exact_supported_loopback(url, allowed) -> None:
    connections: list[tuple[str, str]] = []

    class EndpointProvider(KaggleAiProvider):
        def _connect(self, endpoint: str, token: str) -> object:
            connections.append((endpoint, token))
            return object()

    provider = EndpointProvider(
        lambda: BackendSettings(2, kaggle_url=url, kaggle_token="private-token"),
        discovery_base_url="https://rooms.example",
        discovery_transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )

    if allowed:
        provider.validate_configuration()
        assert connections == [(url, "private-token")]
    else:
        with pytest.raises(DependencyError) as error:
            provider.validate_configuration()
        assert error.value.code == "KaggleUrlInvalid"
        assert connections == []


@pytest.mark.parametrize("protocol_version", [3, 4])
def test_kaggle_health_check_uses_a_short_timeout_and_rejects_stale_timing_workers(
    monkeypatch, protocol_version,
) -> None:
    timeouts: list[object] = []

    class ClientStub:
        def __init__(self, *_args: object, **kwargs: object) -> None:
            timeouts.append(kwargs["httpx_kwargs"]["timeout"])

        def predict(self, *, api_name: str) -> dict[str, int | str]:
            assert api_name == "/health"
            return {"protocolVersion": protocol_version, "sessionGeneration": "worker-test"}

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

    if protocol_version == 3:
        with pytest.raises(DependencyError) as error:
            provider.validate_configuration()
        assert error.value.code == "KaggleProtocolMismatch"
        assert timeouts == [20]
    else:
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
    assert requested_headers == ["eacb9ab8f6db03232e40f809d83464809bdfd41203c70051cc4b42e380732afa"]


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
        start_notebook=lambda _cancel: (
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
