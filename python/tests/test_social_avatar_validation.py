from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app


@pytest.mark.parametrize("data", ["фото", "💿", "%%%"])
def test_invalid_base64_avatar_returns_a_validation_error(data: str) -> None:
    with TestClient(create_room_server_app(relay_port=0)) as client:
        response = client.put(
            "/social/avatar",
            headers={"X-AD-Voice-Device": "avatar-device".ljust(40, "-")},
            json={"mime": "image/png", "data": data},
        )

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "UnsupportedAvatar"
