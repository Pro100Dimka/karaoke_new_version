from __future__ import annotations

import shutil
from pathlib import Path

from backend.infrastructure.youtube_clip import YoutubeClipDownloader


class FakeYoutubeDl:
    def __init__(self, options: dict[str, object]) -> None:
        self._template = str(options["outtmpl"])

    def __enter__(self) -> "FakeYoutubeDl":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def download(self, urls: list[str]) -> int:
        assert urls == ["https://www.youtube.com/watch?v=HVfb25Jq-_A"]
        Path(self._template.replace("%(ext)s", "mp4")).write_bytes(b"downloaded-video")
        return 0


def test_youtube_clip_is_downloaded_and_published_as_local_silent_mp4(tmp_path: Path) -> None:
    destination = tmp_path / "media" / "clip.mp4"

    def transcode(source: Path, target: Path, _duration: float | None) -> bool:
        assert target.suffix == ".mp4"
        shutil.copyfile(source, target)
        return True

    downloader = YoutubeClipDownloader(
        FakeYoutubeDl, transcode=transcode, validate=lambda _path: True
    )

    assert downloader.download(
        "https://www.youtube.com/watch?v=HVfb25Jq-_A",
        destination,
        expected_duration=180,
    )
    assert destination.read_bytes() == b"downloaded-video"
    assert list(destination.parent.glob(".clip-download.*")) == []


def test_youtube_clip_downloader_rejects_non_youtube_sources(tmp_path: Path) -> None:
    downloader = YoutubeClipDownloader(FakeYoutubeDl)

    assert not downloader.download(
        "https://example.test/video.mp4",
        tmp_path / "clip.mp4",
        expected_duration=None,
    )


def test_youtube_clip_downloader_rejects_a_static_audio_upload(tmp_path: Path) -> None:
    destination = tmp_path / "clip.mp4"

    def transcode(source: Path, target: Path, _duration: float | None) -> bool:
        shutil.copyfile(source, target)
        return True

    downloader = YoutubeClipDownloader(
        FakeYoutubeDl, transcode=transcode, validate=lambda _path: False
    )

    assert not downloader.download(
        "https://www.youtube.com/watch?v=HVfb25Jq-_A",
        destination,
        expected_duration=180,
    )
    assert not destination.exists()
