from unittest.mock import Mock

import pytest

from backend.domain_errors import DomainError
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.infrastructure.youtube_radio import YoutubeRadio
from backend.serialization import dumps
from fastapi import FastAPI
from fastapi.testclient import TestClient
from backend.api.radio_routes import router


def result(value):
    return ProcessResult(0, dumps(value).encode(), b"")


@pytest.mark.parametrize("playlist_id", ["PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y", "RD2DrxMxk-5Bk"])
@pytest.mark.parametrize("index", [1, 7])
def test_playlist_resolves_only_the_requested_song_without_downloading(playlist_id, index):
    processes = Mock(spec=ProcessRunner)
    processes.run.side_effect = [
        result(
            {
                "title": "My playlist",
                "playlist_count": None if playlist_id.startswith("RD") else 1200,
                "entries": [{"id": "QUsg4kgvwBo", "title": "Sunrise"}],
            }
        ),
        result(
            {
                "id": "QUsg4kgvwBo",
                "title": "Sunrise",
                "uploader": "NCS",
                "url": "https://music.googlevideo.com/audio?expire=9999999999",
            }
        ),
    ]
    track = YoutubeRadio(processes).resolve(playlist_id, index)
    assert track["index"] == index
    assert track["count"] == (0 if playlist_id.startswith("RD") else 1200)
    assert track["playlistTitle"] == "My playlist"
    assert track["title"] == "Sunrise" and track["artist"] == "NCS"
    calls = [call.args[0] for call in processes.run.call_args_list]
    assert "--flat-playlist" in calls[0]
    assert calls[0][calls[0].index("--playlist-items") + 1] == str(index)
    expected = (
        "https://www.youtube.com/watch?v=2DrxMxk-5Bk&list=RD2DrxMxk-5Bk&start_radio=1"
        if playlist_id.startswith("RD")
        else f"https://www.youtube.com/playlist?list={playlist_id}"
    )
    assert calls[0][-1] == expected
    assert all("--skip-download" in args and "--no-cache-dir" in args for args in calls)
    assert calls[1][-1] == "https://www.youtube.com/watch?v=QUsg4kgvwBo"


@pytest.mark.parametrize("playlist", ["", "../../secret", "https://localhost/", "bad id"])
def test_playlist_rejects_non_youtube_identifiers_before_starting_a_process(playlist):
    processes = Mock(spec=ProcessRunner)
    with pytest.raises(DomainError):
        YoutubeRadio(processes).resolve(playlist, 1)
    processes.run.assert_not_called()


def test_playlist_reports_an_unavailable_stream():
    processes = Mock(spec=ProcessRunner)
    processes.run.return_value = ProcessResult(1, b"", b"private playlist")
    with pytest.raises(DomainError):
        YoutubeRadio(processes).resolve("PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y", 1)


def test_radio_http_response_preserves_track_strings_and_numeric_position(monkeypatch):
    payload = {
        "playlistId": "PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y",
        "index": 7,
        "count": 1200,
        "title": "Sunrise",
        "url": "https://audio.example/track",
    }
    resolve = Mock(return_value=payload)
    monkeypatch.setattr(YoutubeRadio, "resolve", resolve)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        response = client.get(
            "/radio/youtube?playlist_id=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y&index=7"
        )
        assert response.status_code == 200 and response.json() == payload
        resolve.assert_called_once()
        assert resolve.call_args.args == ("PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y", 7)
        resolve.reset_mock()
        assert client.get("/radio/youtube?playlist_id=https://localhost").status_code == 422
        resolve.assert_not_called()
