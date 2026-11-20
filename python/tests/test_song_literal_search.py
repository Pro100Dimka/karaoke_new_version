from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import app_client, write_wav

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("endpoint", ["/songs", "/songs/search"])
@pytest.mark.parametrize("field", ["title", "artist", "originalFilename"])
@pytest.mark.parametrize(("search", "other"), [("50%", "500"), ("take_", "take1")])
def test_literal_punctuation_search_has_only_matching_pages(
    tmp_path: Path, endpoint: str, field: str, search: str, other: str
) -> None:
    with app_client(tmp_path / "runtime") as client:
        expected = []
        for index, (prefix, value) in enumerate((("A", search), ("B", other), ("Z", search))):
            name = f"{prefix} {value}" if field == "originalFilename" else f"audio-{index}"
            source = tmp_path / f"{name}.wav"
            write_wav(source, frequency=300 + index * 80)
            body = {
                "sourcePath": str(source),
                "title": f"{prefix} {value}" if field == "title" else f"{prefix} Song",
                "artist": value if field == "artist" else "Artist",
            }
            created = client.post("/songs", json=body)
            assert created.status_code == 201, created.text
            if index != 1:
                expected.append(created.json()["songId"])

        params = {"search": search, "sort": "title", "descending": "false", "limit": "1"}
        first = client.get(endpoint, params=params)
        assert first.status_code == 200, first.text
        page = first.json()
        assert [item["songId"] for item in page["items"]] == expected[:1]
        assert page["nextCursor"] is not None

        last = client.get(endpoint, params={**params, "cursor": page["nextCursor"]})

        assert last.status_code == 200, last.text
        assert [item["songId"] for item in last.json()["items"]] == expected[1:]
        assert last.json()["nextCursor"] is None
