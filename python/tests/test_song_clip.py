from __future__ import annotations

import shutil
from pathlib import Path
from threading import Event

import pytest

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner

from backend.infrastructure.youtube_clip import YoutubeClipDownloader


@pytest.mark.parametrize("cancel_stage", ["download", "transcode", "motion"])
def test_clip_cancellation_reaches_each_owned_process_and_never_publishes_partial_media(
    tmp_path: Path, cancel_stage: str
) -> None:
    cancel = Event()
    reached = []

    class Processes(ProcessRunner):
        def run(self, command, **kwargs):
            stage = (
                "download"
                if "yt_dlp" in command
                else ("motion" if command[-1] == "pipe:1" else "transcode")
            )
            reached.append(stage)
            assert kwargs.get("cancel") is cancel
            if stage == cancel_stage:
                cancel.set()
                raise DomainError("ProcessCancelled", "External process was cancelled", 499)
            if stage == "download":
                Path(command[command.index("--output") + 1].replace("%(ext)s", "mp4")).write_bytes(
                    b"downloaded-video"
                )
            else:
                Path(command[-1]).write_bytes(b"transcoded-video")
            return ProcessResult(0, b"", b"")

    destination = tmp_path / "clip.mp4"
    assert not YoutubeClipDownloader(processes=Processes()).download(
        "https://www.youtube.com/watch?v=HVfb25Jq-_A",
        destination,
        expected_duration=180,
        cancel=cancel,
    )
    assert reached[-1] == cancel_stage
    assert not destination.exists()
    assert list(tmp_path.glob(".clip*")) == []


class FakeClipProcesses(ProcessRunner):
    def __init__(self, *, motion: bool = True) -> None:
        self.motion = motion

    def run(self, command, **kwargs):
        if "yt_dlp" in command:
            assert command[-1] == "https://www.youtube.com/watch?v=HVfb25Jq-_A"
            template = command[command.index("--output") + 1]
            Path(template.replace("%(ext)s", "mp4")).write_bytes(b"downloaded-video")
        elif command[-1] == "pipe:1":
            return ProcessResult(
                0,
                b"".join(
                    bytes([frame * 40 if self.motion else 0]) * (32 * 18) for frame in range(4)
                ),
                b"",
            )
        else:
            assert "-an" in command
            shutil.copyfile(command[command.index("-i") + 1], command[-1])
        return ProcessResult(0, b"", b"")


def test_youtube_clip_is_downloaded_and_published_as_local_silent_mp4(tmp_path: Path) -> None:
    destination = tmp_path / "media" / "clip.mp4"

    downloader = YoutubeClipDownloader(processes=FakeClipProcesses())

    assert downloader.download(
        "https://www.youtube.com/watch?v=HVfb25Jq-_A",
        destination,
        expected_duration=180,
    )
    assert destination.read_bytes() == b"downloaded-video"
    assert list(destination.parent.glob(".clip-download.*")) == []


def test_youtube_clip_downloader_rejects_non_youtube_sources(tmp_path: Path) -> None:
    downloader = YoutubeClipDownloader(processes=FakeClipProcesses())

    assert not downloader.download(
        "https://example.test/video.mp4",
        tmp_path / "clip.mp4",
        expected_duration=None,
    )


def test_youtube_clip_downloader_rejects_a_static_audio_upload(tmp_path: Path) -> None:
    destination = tmp_path / "clip.mp4"

    downloader = YoutubeClipDownloader(processes=FakeClipProcesses(motion=False))

    assert not downloader.download(
        "https://www.youtube.com/watch?v=HVfb25Jq-_A",
        destination,
        expected_duration=180,
    )
    assert not destination.exists()
