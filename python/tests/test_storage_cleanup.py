from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


def test_cache_clear_removes_only_regenerable_cache(client) -> None:
    response = client.post("/storage/cache/clear")

    assert response.status_code == 200
    assert response.json() == {"removed": 0}
    assert client.get("/songs").status_code == 200


def test_temp_clear_is_available(client) -> None:
    response = client.post("/storage/temp/clear")

    assert response.status_code == 200
    assert response.json()["removed"] >= 0
