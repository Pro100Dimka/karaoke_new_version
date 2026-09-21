from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest

from backend.ai.domain import WordTiming
from backend.domain_errors import DomainError
from backend.infrastructure.paths import safe_relative_path
from backend.songs.domain import Language
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


class TrackingLanguageProvider(FakeAiProvider):
    def __init__(self) -> None:
        super().__init__()
        self.transcribe_languages: list[Language] = []
        self.align_languages: list[Language] = []

    def transcribe(
        self,
        vocal: Path,
        language: Language,
        cancel: threading.Event,
    ) -> str:
        self.transcribe_languages.append(language)
        return super().transcribe(vocal, language, cancel)

    def align(
        self,
        vocal: Path,
        lyrics: str,
        language: Language,
        cancel: threading.Event,
    ) -> tuple[WordTiming, ...]:
        self.align_languages.append(language)
        return super().align(vocal, lyrics, language, cancel)


@pytest.mark.parametrize("language", list(Language))
def test_processing_propagates_selected_language(
    tmp_path: Path,
    language: Language,
) -> None:
    provider = TrackingLanguageProvider()
    source = tmp_path / f"{language.value}.wav"
    write_wav(source, seconds=0.2)
    with app_client(tmp_path / language.value, ai_providers=(provider,)) as client:
        song = import_song(client, source, language=language.value)
        response = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        job = wait_for_job(client, response.json()["jobId"])

    assert job["state"] == "Succeeded"
    assert provider.transcribe_languages == [language]
    assert provider.align_languages == [language]


def test_unicode_filename_import_is_supported(client, tmp_path: Path) -> None:
    source = tmp_path / "пісня-їжак-ёж.wav"
    write_wav(source)

    song = import_song(client, source, title="Їжак", artist="Ёж")
    fetched = client.get(f"/songs/{song['songId']}")

    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Їжак"


@pytest.mark.parametrize(
    "value",
    [
        r"C:\\Windows\\system32\\file.wav",
        r"C:relative\\file.wav",
        r"\\\\server\\share\\file.wav",
        r"folder\\..\\outside.wav",
        "/absolute/file.wav",
    ],
)
def test_windows_and_posix_unsafe_paths_are_rejected_portably(value: str) -> None:
    with pytest.raises(DomainError) as raised:
        safe_relative_path(value)
    assert raised.value.code == "InvalidPath"


@pytest.mark.windows
@pytest.mark.skipif(os.name != "nt", reason="Executed by the Windows CI integration lane")
def test_windows_relative_path_uses_native_semantics() -> None:
    value = safe_relative_path(r"folder\\nested\\song.wav")

    assert not value.is_absolute()
    assert value.parts == ("folder", "nested", "song.wav")
