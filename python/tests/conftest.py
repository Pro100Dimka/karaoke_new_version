from __future__ import annotations

import math
import struct
import wave
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.ai.ports import AiProvider
from backend.api.app import create_app
from backend.bootstrap.config import BackendConfig
from backend.lyrics.ports import OnlineLyricsProvider


def write_wav(
    path: Path,
    *,
    seconds: float = 1.0,
    frequency: float = 440.0,
    sample_rate: int = 16_000,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame_count = int(seconds * sample_rate)
    samples = (
        struct.pack("<h", int(8_000 * math.sin(2 * math.pi * frequency * index / sample_rate)))
        for index in range(frame_count)
    )
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(b"".join(samples))


@contextmanager
def app_client(
    root: Path,
    *,
    ai_providers: Sequence[AiProvider] = (),
    lyrics_providers: Sequence[OnlineLyricsProvider] = (),
) -> Iterator[TestClient]:
    app = create_app(
        BackendConfig.load(root),
        ai_providers=ai_providers,
        lyrics_providers=lyrics_providers,
    )
    with TestClient(app) as client:
        yield client


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with app_client(tmp_path / "runtime") as test_client:
        yield test_client
