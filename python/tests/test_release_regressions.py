"""Release audit 2026-10-06: analysis memory, missing take files, late job results."""

from __future__ import annotations

import threading
import tracemalloc
import wave
from pathlib import Path

import numpy as np
import pytest

from backend.infrastructure.wave_pitch import WavePitchExtractor
from backend.processing.domain import JobState, JobType
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.test_recordings_analysis import ready_song, register_recording
from tests.helpers import import_song, wait_for_job


def _write_long_take(path: Path, seconds: int, frequency: float, rate: int = 48_000) -> None:
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(2)
        audio.setsampwidth(2)
        audio.setframerate(rate)
        block = np.arange(rate) / rate
        tone = (np.sin(2 * np.pi * frequency * block) * 12_000).astype("<i2")
        frames = np.repeat(tone, 2).tobytes()  # the same tone on both channels
        for _ in range(seconds):
            audio.writeframes(frames)


def test_a_four_minute_stereo_take_is_analysed_in_bounded_memory(tmp_path: Path) -> None:
    take = tmp_path / "take.wav"
    _write_long_take(take, seconds=240, frequency=220.0)

    tracemalloc.start()
    points = WavePitchExtractor().extract(take)
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(points) == 240 * 20  # one point per 50 ms window
    voiced = [point.frequency for point in points if point.frequency]
    assert len(voiced) == len(points)
    assert abs(sum(voiced) / len(voiced) - 220.0) < 5.0
    # The whole take was unpacked into Python integers before (~1 GB for this file).
    assert peak < 64 * 1024 * 1024


def test_short_take_keeps_the_previous_window_points(tmp_path: Path) -> None:
    take = tmp_path / "short.wav"
    write_wav(take, frequency=440.0)
    points = WavePitchExtractor().extract(take)
    assert points and all(point.time >= 0 for point in points)
    assert any(abs(point.frequency - 440.0) < 25.0 for point in points)


@pytest.mark.integration
def test_analysis_of_a_take_whose_file_is_gone_is_a_clear_not_found(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)
        Path(recording["filePath"]).unlink()

        started = client.post(f"/recordings/{recording['recordingId']}/analysis")

    assert started.status_code == 404, started.text
    assert started.json()["code"] == "RecordingFileMissing"


@pytest.mark.integration
def test_an_analysis_that_crashes_is_marked_failed_not_left_running(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        recording = register_recording(client, song)

        def out_of_memory(self, path):
            raise MemoryError

        monkeypatch.setattr(WavePitchExtractor, "extract", out_of_memory)
        started = client.post(f"/recordings/{recording['recordingId']}/analysis")
        job = wait_for_job(client, started.json()["jobId"])
        analyses = client.get(f"/recordings/{recording['recordingId']}/analyses").json()

    assert job["state"] == "Failed"
    assert analyses[0]["state"] == "Failed"


def test_a_job_settled_by_startup_recovery_ignores_its_late_result(tmp_path: Path) -> None:
    running, finish = threading.Event(), threading.Event()
    with app_client(tmp_path) as client:
        manager = client.app.state.container.system.jobs

        def work(context):
            running.set()
            assert finish.wait(3)
            return {"done": True}

        job = manager.start(JobType.SONG_PROCESSING, work)
        assert running.wait(3)
        # A restarted backend marks every running job interrupted while this one still works.
        assert manager.recover_interrupted() == 1
        finish.set()
        for _ in range(100):
            if manager.get(job.job_id).state is not JobState.RUNNING:
                break
            threading.Event().wait(0.02)
        threading.Event().wait(0.2)
        assert manager.get(job.job_id).state is JobState.INTERRUPTED


@pytest.mark.integration
def test_history_pages_one_tab_and_names_the_song_of_a_take(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = ready_song(client, source)
        register_recording(client, song)

        performances = client.get(
            "/history",
            params=[("types", "RecordingRegistered"), ("types", "AnalysisCompleted")],
        ).json()
        everything = client.get("/history").json()

    assert performances["total"] == 1
    assert [item["eventType"] for item in performances["items"]] == ["RecordingRegistered"]
    assert performances["items"][0]["songId"] == song["songId"]
    assert everything["total"] > performances["total"]


def test_ffmpeg_shows_its_release_not_the_whole_copyright_banner() -> None:
    from backend.infrastructure.runtime_probe import ffmpeg_release

    banner = "ffmpeg version 8.1.2-essentials_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers"
    assert ffmpeg_release(banner) == "8.1.2-essentials_build-www.gyan.dev"
    assert ffmpeg_release("something unexpected") == "something unexpected"


@pytest.mark.integration
def test_a_recognised_cover_is_fetched_once_card_sized_and_then_served_offline(
    tmp_path: Path, monkeypatch
) -> None:
    import httpx
    from dataclasses import replace

    from backend.infrastructure.artwork_cache import ArtworkCache

    requested: list[str] = []

    def cdn(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=b"\xff\xd8cover")

    source = tmp_path / "song.wav"
    write_wav(source)
    remote = "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/bb/cc/source/1200x1200bb.jpg"
    with app_client(tmp_path / "runtime") as client:
        song_id = import_song(client, source)["songId"]
        container = client.app.state.container
        container.artwork = ArtworkCache(tmp_path / "artwork", httpx.MockTransport(cdn))
        with container.database.create() as transaction:
            song = transaction.songs.get(song_id)
            transaction.songs.update(replace(song, artwork_url=remote))
            transaction.commit()

        listed = client.get(f"/songs/{song_id}").json()["artworkUrl"]
        first = client.get(f"/songs/{song_id}/cover")
        container.artwork = ArtworkCache(tmp_path / "artwork", httpx.MockTransport(lambda request: 1 / 0))
        second = client.get(f"/songs/{song_id}/cover")

    assert listed == f"http://testserver/songs/{song_id}/cover"
    assert first.status_code == 200 and first.content == b"\xff\xd8cover"
    assert first.headers["content-type"] == "image/jpeg"
    assert requested == [remote.replace("1200x1200bb", "600x600bb")]
    assert second.status_code == 200 and second.content == b"\xff\xd8cover"
