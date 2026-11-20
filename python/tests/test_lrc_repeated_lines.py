from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest

from backend.infrastructure.lrclib_provider import LrclibLyricsProvider
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.codec import decode_lrc
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.lyrics.ports import LyricLineTiming
from backend.songs.domain import Language, Song, SongStatus, SourceState
from tests.conftest import app_client, write_wav
from tests.helpers import wait_for_job


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "[00:10.50][00:30.25]Припев\n[00:20]Куплет",
            [(10.5, "Припев"), (20.0, "Куплет"), (30.25, "Припев")],
        ),
        (
            "[00:20][00:40]Первый голос\n[00:10]Вступление\n[00:20]Второй голос",
            [
                (10.0, "Вступление"),
                (20.0, "Первый голос"),
                (20.0, "Второй голос"),
                (40.0, "Первый голос"),
            ],
        ),
        ("[ar:Исполнитель]\n[00:10][00:30] \n[00:20]Слова", [(20.0, "Слова")]),
    ],
)
def test_repeated_lrc_cues_expand_in_time_order(
    raw: str, expected: list[tuple[float, str]]
) -> None:
    assert decode_lrc(raw) == expected


@pytest.mark.integration
def test_imported_lrc_keeps_repeated_lyrics_without_timestamp_text(tmp_path: Path) -> None:
    source = tmp_path / "Виконавець - Пісня.wav"
    write_wav(source, seconds=0.2)
    raw = (
        "[ar:Виконавець]\n[00:00.02][00:00.14]Співаємо цей приспів\n[00:00.08]Другий куплет звучить"
    )
    sidecar = source.with_suffix(".lrc")
    sidecar.write_text(raw, encoding="utf-8")
    with app_client(tmp_path / "runtime") as client:
        started = client.post("/songs/imports", json={"sourcePath": str(source)})
        assert started.status_code == 202, started.text
        completed = wait_for_job(client, started.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        song = client.app.state.container.songs.get_song.execute(completed["report"]["songId"])
        found = (
            LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy())
            .lookup(song, threading.Event(), False)
            .found
        )

        assert found is not None
        assert found.lyrics == "Співаємо цей приспів\nДругий куплет звучить\nСпіваємо цей приспів"
        assert found.timing_hints == (
            LyricLineTiming(0.02, "Співаємо цей приспів"),
            LyricLineTiming(0.08, "Другий куплет звучить"),
            LyricLineTiming(0.14, "Співаємо цей приспів"),
        )
        assert song.embedded_lyrics == raw
        assert sidecar.read_text(encoding="utf-8") == raw


def test_catalog_lrc_keeps_repeated_lyrics_without_timestamp_text() -> None:
    raw = "[00:10][00:30]Поём этот припев\n[00:20]А затем куплет"
    rows = json.dumps([{"trackName": "Песня", "artistName": "Исполнитель", "syncedLyrics": raw}])
    now = datetime(2026, 11, 20, tzinfo=UTC)
    song = Song(
        "song",
        "Песня",
        "Исполнитель",
        "hash",
        SourceState.MANAGED,
        None,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=40,
    )
    provider = LrclibLyricsProvider(fetch=lambda _url, _timeout: rows)

    candidates = provider.search(song, Language.RUSSIAN, threading.Event())

    assert len(candidates) == 1
    assert candidates[0].lyrics == "Поём этот припев\nА затем куплет\nПоём этот припев"
    assert candidates[0].timing_hints == (
        LyricLineTiming(10.0, "Поём этот припев"),
        LyricLineTiming(20.0, "А затем куплет"),
        LyricLineTiming(30.0, "Поём этот припев"),
    )
