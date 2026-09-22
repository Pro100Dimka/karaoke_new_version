from __future__ import annotations

from pathlib import Path

from backend.infrastructure.audd_recognition import AuddRecognitionProvider


def test_audd_metadata_maps_cover_genre_and_optional_youtube_clip(tmp_path: Path) -> None:
    source = tmp_path / "clip.wav"
    source.write_bytes(b"RIFF-audio")
    calls: list[str] = []

    def post(url: str, fields: dict[str, str], file_path: Path, timeout: float) -> object:
        calls.append(url)
        assert fields["return"] == "apple_music,spotify"
        assert file_path == source
        assert timeout == 7.0
        return {
            "status": "success",
            "result": {
                "artist": "Kate Bush",
                "title": "Running Up That Hill",
                "album": "Hounds of Love",
                "song_link": "https://lis.tn/example",
                "apple_music": {
                    "id": "123",
                    "genreNames": ["Pop", "Music"],
                    "artwork": {"url": "https://img.example/{w}x{h}bb.jpg"},
                },
            },
        }

    def find_video(artist: str, title: str) -> str | None:
        assert (artist, title) == ("Kate Bush", "Running Up That Hill")
        return "https://www.youtube.com/watch?v=wp43OdtAAkM"

    result = AuddRecognitionProvider(
        "token", timeout_seconds=7.0, post=post, find_video=find_video
    ).recognize(source)

    assert calls == ["https://api.audd.io/"]
    assert result is not None
    assert result.genre == "Pop"
    assert result.artwork_url == "https://img.example/1200x1200bb.jpg"
    assert result.video_url == "https://www.youtube.com/watch?v=wp43OdtAAkM"
