from __future__ import annotations

import codecs
from pathlib import Path

import pytest

from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from tests.conftest import app_client, write_wav
from tests.helpers import wait_for_job

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("suffix", [".txt", ".lrc"])
@pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16", "utf-16-be"])
def test_import_reads_lyrics_with_an_explicit_unicode_bom(
    tmp_path: Path, suffix: str, encoding: str
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source, seconds=0.2)
    lyrics = ("[00:00.10]" if suffix == ".lrc" else "") + "Пісня про любов\nНаступний рядок"
    sidecar = source.with_suffix(suffix)
    contents = lyrics.replace("\n", "\r\n").encode(encoding)
    if encoding == "utf-16-be":
        contents = codecs.BOM_UTF16_BE + contents
    sidecar.write_bytes(contents)

    with app_client(tmp_path / "runtime") as client:
        started = client.post("/songs/imports", json={"sourcePath": str(source)})
        assert started.status_code == 202, started.text
        completed = wait_for_job(client, started.json()["jobId"])
        assert completed["state"] == "Succeeded", completed
        song = client.app.state.container.songs.get_song.execute(completed["report"]["songId"])
        assert song.embedded_lyrics == lyrics
        assert sidecar.read_bytes() == contents


@pytest.mark.parametrize("data", [b"\x98", "Пісня".encode("utf-32")])
def test_lyrics_reader_does_not_guess_an_unsupported_encoding(tmp_path: Path, data: bytes) -> None:
    source = tmp_path / "song.wav"
    source.with_suffix(".txt").write_bytes(data)

    with pytest.raises(UnicodeDecodeError):
        LocalSidecarLyricsReader().read(source)
