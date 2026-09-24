from __future__ import annotations

import pytest
import time
from dataclasses import replace
from pathlib import Path

from tests.conftest import write_wav
from tests.helpers import import_song
from backend.songs.prepare_clip import LOCAL_CLIP, clip_path


pytestmark = pytest.mark.integration


def test_downloaded_clip_is_exposed_as_local_video_url(client, tmp_path: Path) -> None:
    source = tmp_path / "clip-source.wav"
    write_wav(source)
    created = import_song(client, source, title="Clip Song", artist="Singer")
    song_id = str(created["songId"])
    database = client.app.state.container.database
    with database.create() as transaction:
        song = transaction.songs.get(song_id)
        assert song is not None
        destination = clip_path(song)
        assert destination is not None
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"local-video")
        transaction.songs.update(replace(song, video_url=LOCAL_CLIP))
        transaction.commit()

    fetched = client.get(f"/songs/{song_id}")
    clip = client.get(f"/songs/{song_id}/clip")

    assert fetched.json()["videoUrl"] == f"http://testserver/songs/{song_id}/clip"
    assert clip.status_code == 200
    assert clip.headers["content-type"].startswith("video/mp4")
    assert clip.content == b"local-video"


def test_import_get_update_delete_song(client, tmp_path: Path) -> None:
    source = tmp_path / "track.wav"
    write_wav(source)
    created = import_song(client, source, title="Original", artist="Singer", language="Ukrainian")
    song_id = str(created["songId"])

    fetched = client.get(f"/songs/{song_id}")
    assert fetched.status_code == 200
    assert fetched.json()["title"] == "Original"

    updated = client.patch(
        f"/songs/{song_id}",
        json={"title": "Updated", "artist": "New Artist", "language": "English"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["title"] == "Updated"
    assert updated.json()["language"] == "English"

    deleted = client.delete(f"/songs/{song_id}")
    assert deleted.status_code == 204
    assert client.get(f"/songs/{song_id}").status_code == 404


def test_duplicate_content_is_rejected(client, tmp_path: Path) -> None:
    source = tmp_path / "same.wav"
    write_wav(source)
    import_song(client, source)

    duplicate = client.post("/songs", json={"sourcePath": str(source)})

    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "DuplicateSong"
    assert duplicate.json()["details"]["existingSongId"]


def test_import_idempotency_returns_same_entity(client, tmp_path: Path) -> None:
    source = tmp_path / "idem.wav"
    write_wav(source)

    first = import_song(client, source, idempotency_key="same-request")
    second = import_song(client, source, idempotency_key="same-request")

    assert first["songId"] == second["songId"]


def test_song_import_runs_as_a_cancellable_progress_job(client, tmp_path: Path) -> None:
    source = tmp_path / "background-import.wav"
    write_wav(source)

    started = client.post("/songs/imports", json={"sourcePath": str(source)})
    assert started.status_code == 202
    job_id = started.json()["jobId"]
    states = []
    for _ in range(500):
        job = client.get(f"/jobs/{job_id}").json()
        states.append((job["state"], job["overallProgress"], job["stage"]))
        if job["state"] in {"Succeeded", "Failed", "Cancelled"}:
            break
        time.sleep(0.02)

    assert job["state"] == "Succeeded", job
    assert job["overallProgress"] == 1
    assert job["report"]["songId"]
    assert any(progress > 0 for _state, progress, _stage in states)


def test_idempotency_key_cannot_be_reused_for_different_input(client, tmp_path: Path) -> None:
    first = tmp_path / "first.wav"
    second = tmp_path / "second.wav"
    write_wav(first, frequency=440)
    write_wav(second, frequency=550)
    import_song(client, first, idempotency_key="key")

    response = client.post(
        "/songs",
        json={"sourcePath": str(second), "title": "Other", "artist": "Artist"},
        headers={"Idempotency-Key": "key"},
    )

    assert response.status_code == 409
    assert response.json()["code"] == "IdempotencyConflict"


def test_invalid_and_unsupported_media_are_rejected_without_library_side_effect(
    client, tmp_path: Path
) -> None:
    broken = tmp_path / "broken.wav"
    broken.write_bytes(b"not-wave")
    invalid = client.post("/songs", json={"sourcePath": str(broken)})

    unsupported = tmp_path / "track.txt"
    unsupported.write_text("x", encoding="utf-8")
    unsupported_response = client.post("/songs", json={"sourcePath": str(unsupported)})

    assert invalid.status_code == 400
    assert invalid.json()["code"] == "InvalidMedia"
    assert unsupported_response.status_code == 415
    assert unsupported_response.json()["code"] == "UnsupportedMedia"
    assert client.get("/songs").json()["items"] == []


def test_unicode_case_insensitive_search(client, tmp_path: Path) -> None:
    source = tmp_path / "unicode.wav"
    write_wav(source)
    import_song(client, source, title="Пісня Їжак", artist="ВИКОНАВЕЦЬ")

    by_title = client.get("/songs", params={"search": "пІсНя"})
    by_artist = client.get("/songs", params={"search": "виконавець"})

    assert len(by_title.json()["items"]) == 1
    assert len(by_artist.json()["items"]) == 1


def test_song_exposes_and_searches_original_filename(client, tmp_path: Path) -> None:
    source = tmp_path / "Hidden Original Name.wav"
    write_wav(source)
    created = import_song(client, source, title="Different title", artist="Singer")

    found = client.get("/songs", params={"search": "original name"})

    assert created["originalFilename"] == source.name
    assert [item["songId"] for item in found.json()["items"]] == [created["songId"]]


def test_custom_cover_can_be_served_and_removed(client, tmp_path: Path) -> None:
    source = tmp_path / "cover-song.wav"
    cover = tmp_path / "cover.png"
    write_wav(source)
    cover.write_bytes(b"\x89PNG\r\n\x1a\ncustom-cover")
    created = import_song(client, source)
    song_id = str(created["songId"])

    updated = client.patch(f"/songs/{song_id}", json={"coverPath": str(cover)})
    served = client.get(f"/songs/{song_id}/cover")
    removed = client.delete(f"/songs/{song_id}/cover")

    assert updated.status_code == 200
    assert updated.json()["coverState"] == "Custom"
    assert updated.json()["artworkUrl"] == f"http://testserver/songs/{song_id}/cover"
    assert served.status_code == 200
    assert served.content == cover.read_bytes()
    assert removed.status_code == 200
    assert removed.json()["coverState"] != "Custom"


def test_processed_song_exposes_detected_bpm_and_key(client, tmp_path: Path) -> None:
    source = tmp_path / "metadata.wav"
    write_wav(source)
    created = import_song(client, source)
    song_id = str(created["songId"])
    database = client.app.state.container.database
    with database.create() as transaction:
        song = transaction.songs.get(song_id)
        assert song is not None
        transaction.songs.update(replace(song, detected_bpm=128.5, detected_key="Am"))
        transaction.commit()

    fetched = client.get(f"/songs/{song_id}")

    assert fetched.json()["detectedBpm"] == 128.5
    assert fetched.json()["detectedKey"] == "Am"


def test_cursor_pagination_has_no_duplicates(client, tmp_path: Path) -> None:
    for index in range(5):
        source = tmp_path / f"{index}.wav"
        write_wav(source, frequency=440 + index * 20)
        import_song(client, source, title=f"Song {index}")

    first = client.get("/songs", params={"limit": 2}).json()
    second = client.get("/songs", params={"limit": 2, "cursor": first["nextCursor"]}).json()
    third = client.get("/songs", params={"limit": 2, "cursor": second["nextCursor"]}).json()
    ids = [item["songId"] for page in (first, second, third) for item in page["items"]]

    assert len(ids) == 5
    assert len(ids) == len(set(ids))
    assert third["nextCursor"] is None


def test_invalid_cursor_is_rejected(client) -> None:
    response = client.get("/songs", params={"cursor": "@@not-base64@@"})

    assert response.status_code == 400
    assert response.json()["code"] == "InvalidCursor"


def test_sort_has_stable_secondary_key(client, tmp_path: Path) -> None:
    for index in range(3):
        source = tmp_path / f"stable-{index}.wav"
        write_wav(source, frequency=500 + index * 10)
        import_song(client, source, title="Same", artist="Artist")

    first = client.get("/songs", params={"sort": "title"}).json()["items"]
    second = client.get("/songs", params={"sort": "title"}).json()["items"]

    assert [item["songId"] for item in first] == [item["songId"] for item in second]
