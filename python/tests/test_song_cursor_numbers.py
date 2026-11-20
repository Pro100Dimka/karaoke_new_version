from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from tests.conftest import write_wav
from tests.helpers import import_song

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("offset", [2**63, 10**100])
def test_song_list_rejects_cursor_offsets_outside_sqlite_range(client, offset: int) -> None:
    cursor = base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii")

    response = client.get("/songs", params={"cursor": cursor})

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "InvalidCursor"


@pytest.mark.parametrize("offset", [0, 2**63 - 1])
def test_song_list_accepts_cursor_offsets_at_sqlite_boundaries(client, offset: int) -> None:
    cursor = base64.urlsafe_b64encode(str(offset).encode("ascii")).decode("ascii")

    response = client.get("/songs", params={"cursor": cursor})

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []


@pytest.mark.parametrize("sort", ["duration", "bpm"])
def test_song_search_rejects_a_cursor_number_above_float_range(
    client, tmp_path: Path, sort: str
) -> None:
    cursor = _cursor_with_numeric_value(client, tmp_path, sort, 10**400)

    response = client.get(
        "/songs/search", params={"sort": sort, "descending": False, "cursor": cursor}
    )

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "InvalidCursor"


@pytest.mark.parametrize("sort", ["duration", "bpm"])
def test_song_search_accepts_a_finite_integer_cursor_value(
    client, tmp_path: Path, sort: str
) -> None:
    cursor = _cursor_with_numeric_value(client, tmp_path, sort, 2**63)

    response = client.get(
        "/songs/search", params={"sort": sort, "descending": False, "cursor": cursor}
    )

    assert response.status_code == 200, response.text
    assert response.json()["items"] == []
    assert response.json()["nextCursor"] is None


@pytest.mark.parametrize("sort", ["duration", "bpm"])
def test_song_search_numeric_cursor_keeps_the_next_equal_value(
    client, tmp_path: Path, sort: str
) -> None:
    cursor = _cursor_with_numeric_value(client, tmp_path, sort, None)
    first_id = json.loads(base64.urlsafe_b64decode(cursor))[3]

    response = client.get(
        "/songs/search", params={"sort": sort, "descending": False, "cursor": cursor}
    )

    assert response.status_code == 200, response.text
    assert len(response.json()["items"]) == 1
    assert response.json()["items"][0]["songId"] != first_id
    assert response.json()["nextCursor"] is None


def _cursor_with_numeric_value(client, tmp_path: Path, sort: str, value: int | None) -> str:
    for index in range(2):
        source = tmp_path / f"source-{index}.wav"
        write_wav(source, frequency=440 + index * 100)
        import_song(client, source)
    first = client.get("/songs/search", params={"sort": sort, "descending": False, "limit": 1})
    assert first.status_code == 200, first.text
    payload = json.loads(base64.urlsafe_b64decode(first.json()["nextCursor"]))
    if value is not None:
        payload[2] = value
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
