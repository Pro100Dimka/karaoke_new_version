from __future__ import annotations

import threading
from pathlib import Path

import numpy as np
import soundfile as sf

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

    def _client(self) -> _Client:
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
