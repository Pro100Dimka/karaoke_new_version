from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from backend.songs.recognition import RecognizedSong
from tests.conftest import app_client, write_wav


pytestmark = pytest.mark.integration


@dataclass
class FakeRecognizer:
    result: RecognizedSong | None

    def recognize(self, source: Path) -> RecognizedSong | None:
        assert source.is_file()
        return self.result


@dataclass
class SequenceRecognizer:
    results: list[RecognizedSong | None]

    def recognize(self, source: Path) -> RecognizedSong | None:
        assert source.is_file()
        return self.results.pop(0)


def test_import_uses_recognized_song_metadata_for_the_library_and_later_searches(
    tmp_path: Path,
) -> None:
    source = tmp_path / "unknown.wav"
    write_wav(source)
    recognized = RecognizedSong(
        title="Running Up That Hill",
        artist="Kate Bush",
        album="Hounds of Love",
        genre="Pop",
        artwork_url="https://images.example/cover.jpg",
        video_url="https://www.youtube.com/watch?v=wp43OdtAAkM",
        provider="AudD",
        external_id="123",
    )

    with app_client(
        tmp_path / "runtime", recognition_provider=FakeRecognizer(recognized)
    ) as client:
        response = client.post("/songs", json={"sourcePath": str(source)})

    assert response.status_code == 201, response.text
    assert response.json()["title"] == recognized.title
    assert response.json()["artist"] == recognized.artist
    assert response.json()["album"] == recognized.album
    assert response.json()["genre"] == recognized.genre
    assert response.json()["artworkUrl"] == recognized.artwork_url
    assert response.json()["videoUrl"] == recognized.video_url


def test_explicit_user_title_and_artist_win_over_recognition(tmp_path: Path) -> None:
    source = tmp_path / "known.wav"
    write_wav(source)
    recognized = RecognizedSong("Detected", "Detected Artist", "Album", None, None, None)

    with app_client(
        tmp_path / "runtime-user", recognition_provider=FakeRecognizer(recognized)
    ) as client:
        response = client.post(
            "/songs",
            json={"sourcePath": str(source), "title": "My title", "artist": "My artist"},
        )

    assert response.status_code == 201, response.text
    assert (response.json()["title"], response.json()["artist"]) == ("My title", "My artist")


def test_processing_refreshes_recognition_for_a_song_imported_before_fingerprinting(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Artist - Old title.wav"
    write_wav(source)
    recognized = RecognizedSong(
        "Correct title",
        "Correct artist",
        "Correct album",
        "Rock",
        "https://images.example/correct.jpg",
        "https://www.youtube.com/watch?v=correct",
        "AudD",
        "track-42",
    )
    recognizer = SequenceRecognizer([None, recognized])

    with app_client(tmp_path / "runtime-refresh", recognition_provider=recognizer) as client:
        imported = client.post("/songs", json={"sourcePath": str(source)}).json()
        # The processing environment may reject the job before AI work; recognition enrichment must
        # already have happened so old library entries can be repaired without re-importing files.
        client.post(
            f"/songs/{imported['songId']}/processing",
            json={"mode": "Auto", "onlineLyrics": True},
        )
        refreshed = client.get(f"/songs/{imported['songId']}").json()

    assert refreshed["title"] == recognized.title
    assert refreshed["artist"] == recognized.artist
    assert refreshed["album"] == recognized.album
    assert refreshed["genre"] == recognized.genre
    assert refreshed["artworkUrl"] == recognized.artwork_url
    assert refreshed["videoUrl"] == recognized.video_url
    assert refreshed["recognitionProvider"] == "AudD"


def test_recognition_refresh_preserves_manual_title_and_artist(tmp_path: Path) -> None:
    source = tmp_path / "original.wav"
    write_wav(source)
    recognized = RecognizedSong("Detected", "Detected Artist", "Album", "Pop")
    recognizer = SequenceRecognizer([None, recognized])

    with app_client(tmp_path / "runtime-overrides", recognition_provider=recognizer) as client:
        imported = client.post(
            "/songs",
            json={"sourcePath": str(source), "title": "My title", "artist": "My artist"},
        ).json()
        client.post(
            f"/songs/{imported['songId']}/processing",
            json={"mode": "Auto", "onlineLyrics": True},
        )
        refreshed = client.get(f"/songs/{imported['songId']}").json()

    assert (refreshed["title"], refreshed["artist"]) == ("My title", "My artist")
    assert (refreshed["album"], refreshed["genre"]) == ("Album", "Pop")
