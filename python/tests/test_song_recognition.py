from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from dataclasses import replace

import pytest

from backend.songs.recognition import RecognizedSong
from tests.conftest import app_client, write_wav
from backend.songs.domain import CoverState
from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.artwork_cache import ArtworkCache
from backend.infrastructure.process_runner import ProcessRunner
import httpx


pytestmark = pytest.mark.integration


def test_import_ignores_embedded_artwork_and_existing_embedded_covers_use_the_catalog(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    extracted = []
    monkeypatch.setattr(
        FfmpegMediaInspector, "extract_artwork", lambda *args: extracted.append(args) or False
    )
    with app_client(tmp_path / "runtime") as client:
        song = client.post("/songs", json={"sourcePath": str(source)}).json()
        assert not extracted
        container = client.app.state.container
        embedded = tmp_path / "embedded.jpg"
        embedded.write_bytes(b"embedded")
        container.artwork = ArtworkCache(
            tmp_path / "artwork",
            httpx.MockTransport(
                lambda request: httpx.Response(
                    200, headers={"content-type": "image/jpeg"}, content=b"catalog"
                )
            ),
        )
        with container.database.create() as transaction:
            stored = transaction.songs.get(song["songId"])
            transaction.songs.update(
                replace(
                    stored,
                    cover_path=embedded,
                    cover_state=CoverState.EMBEDDED,
                    artwork_url="https://images.example/cover.jpg",
                )
            )
            transaction.commit()
        assert client.get(f"/songs/{song['songId']}/cover").content == b"catalog"
        with container.database.create() as transaction:
            stored = transaction.songs.get(song["songId"])
            transaction.songs.update(replace(stored, cover_state=CoverState.CUSTOM))
            transaction.commit()
        assert client.get(f"/songs/{song['songId']}/cover").content == b"embedded"


def test_song_waveform_uses_the_imported_audio_before_processing(tmp_path: Path) -> None:
    import wave

    source = tmp_path / "waveform.wav"
    write_wav(source)
    with wave.open(str(source), "rb") as original:
        parameters, audio = original.getparams(), original.readframes(original.getnframes())
    with wave.open(str(source), "wb") as output:
        output.setparams(parameters)
        output.writeframes(bytes(len(audio) // 2) + audio[len(audio) // 2 :])
    with app_client(tmp_path / "runtime") as client:
        song = client.post("/songs", json={"sourcePath": str(source)}).json()
        response = client.get(f"/songs/{song['songId']}/waveform?bins=32")
        assert response.status_code == 200, response.text
        peaks = response.json()
        assert len(peaks) == 32
        assert max(peaks[:14]) == 0
        assert min(peaks[18:]) > 0.8
        assert client.get(f"/songs/{song['songId']}/waveform?bins=0").status_code == 422


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
    # A recognised remote cover is served through the local cache, never hot-linked by the UI.
    assert response.json()["artworkUrl"].endswith(f"/songs/{response.json()['songId']}/cover")
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


def test_import_preserves_equivalent_local_artist_spelling(tmp_path: Path) -> None:
    source = tmp_path / "Нервы - Счастье.wav"
    write_wav(source)
    recognized = RecognizedSong("Счастье", "Nervy", provider="Shazam")

    with app_client(
        tmp_path / "runtime-local-spelling", recognition_provider=FakeRecognizer(recognized)
    ) as client:
        response = client.post("/songs", json={"sourcePath": str(source)})

    assert response.status_code == 201, response.text
    assert response.json()["artist"] == "Нервы"


def test_import_rejects_incorrect_local_artist_spelling(tmp_path: Path) -> None:
    source = tmp_path / "Нервыы - Счастье.wav"
    write_wav(source)
    recognized = RecognizedSong("Счастье", "Nervy", provider="Shazam")

    with app_client(
        tmp_path / "runtime-wrong-local-spelling",
        recognition_provider=FakeRecognizer(recognized),
    ) as client:
        response = client.post("/songs", json={"sourcePath": str(source)})

    assert response.status_code == 201, response.text
    assert response.json()["artist"] == "Nervy"


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
    assert refreshed["artworkUrl"].endswith(f"/songs/{imported['songId']}/cover")
    assert refreshed["videoUrl"] == recognized.video_url
    assert refreshed["recognitionProvider"] == "AudD"


def test_processing_refresh_preserves_equivalent_local_artist_spelling(
    tmp_path: Path,
) -> None:
    source = tmp_path / "Нервы - Счастье.wav"
    write_wav(source)
    recognized = RecognizedSong("Счастье", "Nervy", provider="Shazam")
    recognizer = SequenceRecognizer([None, recognized])

    with app_client(
        tmp_path / "runtime-refresh-local-spelling", recognition_provider=recognizer
    ) as client:
        imported = client.post("/songs", json={"sourcePath": str(source)}).json()
        client.post(
            f"/songs/{imported['songId']}/processing",
            json={"mode": "Auto", "onlineLyrics": True},
        )
        refreshed = client.get(f"/songs/{imported['songId']}").json()

    assert refreshed["artist"] == "Нервы"


def test_processing_upgrades_catalog_guess_to_audio_fingerprint(tmp_path: Path) -> None:
    source = tmp_path / "Architects - Animals.wav"
    write_wav(source)
    catalog = RecognizedSong(
        "Animals",
        "The Native Architects",
        "Wrong Album",
        "Alternative",
        provider="Apple Music Search",
    )
    fingerprint = RecognizedSong(
        "Animals",
        "Architects",
        "For Those That Wish to Exist",
        "Hard Rock",
        provider="Shazam",
        external_id="538829124",
    )
    recognizer = SequenceRecognizer([catalog, fingerprint])

    with app_client(tmp_path / "runtime-upgrade", recognition_provider=recognizer) as client:
        imported = client.post("/songs", json={"sourcePath": str(source)}).json()
        client.post(
            f"/songs/{imported['songId']}/processing",
            json={"mode": "Auto", "onlineLyrics": True},
        )
        refreshed = client.get(f"/songs/{imported['songId']}").json()

    assert refreshed["artist"] == "Architects"
    assert refreshed["album"] == "For Those That Wish to Exist"
    assert refreshed["genre"] == "Hard Rock"
    assert refreshed["recognitionProvider"] == "Shazam"


def test_processing_retries_video_lookup_for_fingerprint_without_a_clip(tmp_path: Path) -> None:
    source = tmp_path / "Скрябін - Не треба.wav"
    write_wav(source)
    fingerprint_without_video = RecognizedSong(
        "Не треба",
        "Skryabin",
        "Хробак",
        "Rock",
        provider="Shazam",
        external_id="track-1",
    )
    fingerprint_with_video = RecognizedSong(
        "Не треба",
        "Skryabin",
        "Хробак",
        "Rock",
        video_url="https://www.youtube.com/watch?v=xAPf954XNwk",
        provider="Shazam",
        external_id="track-1",
    )
    recognizer = SequenceRecognizer([fingerprint_without_video, fingerprint_with_video])

    with app_client(tmp_path / "runtime-video-retry", recognition_provider=recognizer) as client:
        imported = client.post("/songs", json={"sourcePath": str(source)}).json()
        client.post(
            f"/songs/{imported['songId']}/processing",
            json={"mode": "Auto", "onlineLyrics": True},
        )
        refreshed = client.get(f"/songs/{imported['songId']}").json()

    assert refreshed["videoUrl"] == fingerprint_with_video.video_url


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


@pytest.mark.parametrize("provider", [None, "Apple Music Search", "Shazam", "AudD"])
def test_processing_does_not_replace_an_identified_song_with_an_unrelated_fingerprint(
    tmp_path: Path, provider: str | None
) -> None:
    source = tmp_path / "otorvald_- Фонари.wav"
    write_wav(source)
    original = RecognizedSong(
        "Ліхтарі",
        "Оторвальд",
        "Original album",
        artwork_url="https://images.test/ot.jpg",
        provider=provider or "",
        external_id="original-id",
    )
    unrelated = RecognizedSong(
        "Son Banza",
        "Ismail Tsito & Zainab Sambisa & Yamu Bab",
        "Wrong album",
        artwork_url="https://images.test/wrong.jpg",
        video_url="https://youtu.be/HVfb25Jq-_A",
        provider="Shazam",
        external_id="wrong-id",
    )
    with app_client(
        tmp_path / "runtime",
        recognition_provider=SequenceRecognizer([original if provider else None, unrelated]),
    ) as client:
        imported = client.post("/songs", json={"sourcePath": str(source)}).json()
        client.post(
            f"/songs/{imported['songId']}/processing",
            json={"mode": "Auto", "onlineLyrics": True},
        )
        refreshed = client.get(f"/songs/{imported['songId']}").json()

    for field in (
        "title",
        "artist",
        "album",
        "artworkUrl",
        "recognitionProvider",
        "videoUrl",
    ):
        assert refreshed[field] == imported[field], field


def test_rejected_fingerprint_still_enriches_the_correct_tagged_song_from_the_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "otorvald_- Фонари.wav"
    write_wav(source)
    metadata = replace(
        FfmpegMediaInspector(ProcessRunner()).inspect(source), title="Ліхтарі", artist="O.Torvald"
    )
    monkeypatch.setattr(FfmpegMediaInspector, "inspect", lambda *_: metadata)
    recognizer = SequenceRecognizer(
        [None, RecognizedSong("Son Banza", "Unrelated Artist", provider="Shazam")]
    )

    class Catalog:
        def lookup(self, artist, title):
            assert (artist, title) == ("O.Torvald", "Ліхтарі")
            return RecognizedSong(
                title,
                artist,
                "Бісайди",
                artwork_url="https://img.test/cover.jpg",
                provider="Apple Music Search",
                external_id="42",
            )

    with app_client(
        tmp_path / "runtime", recognition_provider=recognizer, catalog_lookup=Catalog()
    ) as client:
        song = client.post("/songs", json={"sourcePath": str(source)}).json()
        client.post(f"/songs/{song['songId']}/processing", json={"mode": "Auto"})
        enriched = client.get(f"/songs/{song['songId']}").json()

    assert (enriched["artist"], enriched["title"]) == ("O.Torvald", "Ліхтарі")
    assert enriched["album"] == "Бісайди"
    assert enriched["artworkUrl"].endswith(f"/songs/{song['songId']}/cover")
    assert not recognizer.results
