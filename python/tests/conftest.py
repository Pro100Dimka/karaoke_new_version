from __future__ import annotations

import math
import os
import struct
import wave
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import backend.api.room_identity as room_identity
from backend.ai.ports import AiProvider
from backend.api.app import create_app
from backend.bootstrap.config import BackendConfig
from backend.lyrics.ports import OnlineLyricsProvider
from backend.songs.recognition import SongRecognitionProvider


@pytest.fixture(autouse=True)
def isolate_private_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AD_VOICE_PROJECT_ENV_FILE", str(tmp_path / "project.env"))
    monkeypatch.setenv("AD_VOICE_ENV_FILE", os.devnull)
    monkeypatch.setenv("AD_VOICE_FRONTEND_ENV_FILE", str(tmp_path / "frontend.env"))
    for name in ("AD_VOICE_AUDD_TOKEN", "AD_VOICE_YOUTUBE_API_KEY"):
        monkeypatch.delenv(name, raising=False)



@pytest.fixture(autouse=True)
def room_keys_equal_participant_ids(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    Room behavior tests name participants "host" or "g1". The room server accepts a participant id only
    with that participant's key, so here the key is the id itself and every test request carries it.
    Tests marked `real_room_keys` exercise the real key-to-id hashing instead.
    """
    if request.node.get_closest_marker("real_room_keys"):
        return
    monkeypatch.setattr(
        room_identity, "_key_owner", lambda req: req.headers.get(room_identity.ROOM_KEY_HEADER)
    )
    original = TestClient.request

    def request_with_room_key(self: TestClient, method: str, url: object, **kwargs: object):  # type: ignore[no-untyped-def]
        body = kwargs.get("json")
        headers = dict(kwargs.get("headers") or {})  # type: ignore[call-overload]
        params = kwargs.get("params")
        claimed = (
            (body.get("participantId") if isinstance(body, dict) else None)
            or headers.get("X-Participant-Id")
            or (params.get("participantId") if isinstance(params, dict) else None)
            or _query_participant(str(url))
        )
        if claimed and room_identity.ROOM_KEY_HEADER not in headers:
            headers[room_identity.ROOM_KEY_HEADER] = claimed
            kwargs["headers"] = headers
        return original(self, method, url, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(TestClient, "request", request_with_room_key)


def _query_participant(url: str) -> str | None:
    from urllib.parse import parse_qs, urlsplit

    return (parse_qs(urlsplit(url).query).get("participantId") or [None])[0]

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
    recognition_provider: SongRecognitionProvider | None = None,
) -> Iterator[TestClient]:
    app = create_app(
        BackendConfig.load(root),
        ai_providers=ai_providers,
        lyrics_providers=lyrics_providers,
        recognition_provider=recognition_provider,
    )
    with TestClient(app) as client:
        yield client


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    with app_client(tmp_path / "runtime") as test_client:
        yield test_client
