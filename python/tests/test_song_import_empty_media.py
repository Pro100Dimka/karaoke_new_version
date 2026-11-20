from __future__ import annotations

from pathlib import Path

import pytest

from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.process_runner import ProcessRunner
from tests.conftest import app_client, write_wav
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("queued", [False, True])
def test_empty_wave_is_rejected_before_creating_a_library_song(
    tmp_path: Path, queued: bool
) -> None:
    source = tmp_path / "Empty.wav"
    write_wav(source, seconds=0)
    original = source.read_bytes()
    with app_client(tmp_path / "runtime") as client:
        response = client.post(
            "/songs/imports" if queued else "/songs", json={"sourcePath": str(source)}
        )
        if queued:
            assert response.status_code == 202, response.text
            job = wait_for_job(client, response.json()["jobId"])
            assert job["state"] == "Failed", job
            assert job["error"]["code"] == "InvalidMedia"
            assert job["report"] is None
        else:
            assert response.status_code == 400, response.text
            assert response.json()["code"] == "InvalidMedia"
        assert client.get("/songs").json()["items"] == []
        assert not tuple(client.app.state.container.roots.songs.iterdir())
        assert source.read_bytes() == original


@pytest.mark.parametrize("queued", [False, True])
def test_nonempty_silent_wave_can_be_imported(tmp_path: Path, queued: bool) -> None:
    source = tmp_path / "Silence.wav"
    write_wav(source, frequency=0)
    with app_client(tmp_path / "runtime") as client:
        response = client.post(
            "/songs/imports" if queued else "/songs", json={"sourcePath": str(source)}
        )
        if queued:
            assert response.status_code == 202, response.text
            job = wait_for_job(client, response.json()["jobId"])
            assert job["state"] == "Succeeded", job
            song = client.get(f"/songs/{job['report']['songId']}").json()
        else:
            assert response.status_code == 201, response.text
            song = response.json()
        assert song["duration"] == pytest.approx(1)
        assert len(client.get("/songs").json()["items"]) == 1
        stored = client.app.state.container.songs.get_song.execute(song["songId"])
        assert stored.source_path.read_bytes() == source.read_bytes()


def test_readable_audio_without_duration_metadata_is_still_valid(tmp_path: Path) -> None:
    source = tmp_path / "Silence.wav"
    write_wav(source, frequency=0, seconds=0.2)
    streamed = tmp_path / "Live.webm"
    runner = ProcessRunner()
    encoded = runner.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(source),
            "-c:a",
            "libopus",
            "-f",
            "webm",
            "-live",
            "1",
            str(streamed),
        ],
        timeout_seconds=15,
    )
    assert encoded.exit_code == 0, encoded.stderr

    metadata = FfmpegMediaInspector(runner).inspect(streamed)

    assert metadata.duration is None
