from __future__ import annotations

import json
import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app
from backend.infrastructure.room_diagnostics import RoomDiagnosticsLog

_ROOM = "2a405dc3-2d1a-4507-8b0f-e3a5a660f53f"


def _lines(root: Path, room: str) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for path in sorted((root / room).glob("*.jsonl"))
        for line in path.read_text(encoding="utf-8").splitlines()
    ]


def test_each_upload_becomes_one_line_per_participant(tmp_path: Path) -> None:
    log = RoomDiagnosticsLog(tmp_path)
    assert log.append(_ROOM, "host", {"Backend": "ASIO", "RoomCompensationFrames": "960"})
    assert log.append(_ROOM, "guest", {"Backend": "WASAPI Shared"})
    lines = _lines(tmp_path, _ROOM)
    assert [line["participantId"] for line in lines] == ["host", "guest"]
    assert lines[0]["values"] == {"Backend": "ASIO", "RoomCompensationFrames": "960"}


def test_a_room_id_cannot_escape_the_log_folder(tmp_path: Path) -> None:
    log = RoomDiagnosticsLog(tmp_path / "logs")
    assert not log.append("../outside", "host", {"Backend": "ASIO"})
    assert not (tmp_path / "outside").exists()


def test_a_room_stops_logging_at_its_daily_size_limit(tmp_path: Path) -> None:
    log = RoomDiagnosticsLog(tmp_path, max_bytes_per_room=300)
    results = [log.append(_ROOM, "host", {"Value": "x" * 50}) for _ in range(10)]
    assert results[0] and not results[-1]
    assert sum(path.stat().st_size for path in (tmp_path / _ROOM).glob("*.jsonl")) <= 300


def test_logs_older_than_the_retention_period_are_removed(tmp_path: Path) -> None:
    old_room = tmp_path / "old-room"
    old_room.mkdir()
    old_log = old_room / "2026-01-01.jsonl"
    old_log.write_text("{}\n", encoding="utf-8")
    eight_days_ago = time.time() - 8 * 86_400
    os.utime(old_log, (eight_days_ago, eight_days_ago))
    RoomDiagnosticsLog(tmp_path).append(_ROOM, "host", {"Backend": "ASIO"})
    assert not old_room.exists()
    assert (tmp_path / _ROOM).is_dir()


def test_only_room_members_can_upload_diagnostics(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, diagnostics_root=tmp_path)
    with TestClient(app) as client:
        code = client.post(
            "/rooms", json={"participantId": "host-1", "displayName": "Host"}
        ).json()["roomId"]
        accepted = client.post(
            f"/rooms/{code}/diagnostics",
            json={"participantId": "host-1", "values": {"Backend": "ASIO"}},
        )
        rejected = client.post(
            f"/rooms/{code}/diagnostics",
            json={"participantId": "stranger", "values": {"Backend": "ASIO"}},
        )
    assert accepted.status_code == 204
    assert rejected.status_code in (403, 404)
    assert [line["participantId"] for line in _lines(tmp_path, code)] == ["host-1"]


def test_room_diagnostics_include_the_server_return_send_cadence(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, diagnostics_root=tmp_path)
    with TestClient(app) as client:
        room = client.post(
            "/rooms", json={"participantId": "host-1", "displayName": "Host"}
        ).json()["roomId"]
        response = client.post(
            f"/rooms/{room}/diagnostics",
            json={"participantId": "host-1", "values": {"Backend": "ASIO"}},
        )

    assert response.status_code == 204
    values = _lines(tmp_path, room)[0]["values"]
    expected = {
        "ServerSendPackets": "0",
        "ServerSendGapLatestMs": "0.0",
        "ServerSendGapMaximumMs": "0.0",
        "ServerSendStalls": "0",
        "ServerSendMonotonicMs": "0.0",
        "ServerPipelinePosition": "0",
        "ServerPipelineGeneration": "0",
        "ServerPipelinePositionWaitMs": "0.0",
        "ServerPipelineMixBuildMs": "0.0",
        "ServerPipelineSendtoMs": "0.0",
        "ServerPipelineIngressGapLatestMs": "0.0",
        "ServerPipelineIngressGapMaximumMs": "0.0",
        "ServerMixCompletePositions": "0",
        "ServerMixPartialPositions": "0",
        "ServerMixMissingContributions": "0",
        "ServerGapClientSendStall": "0",
        "ServerGapNetworkOrIngressStall": "0",
        "ServerGapPositionCollectionStall": "0",
        "ServerGapMixBuildStall": "0",
        "ServerGapSendtoStall": "0",
        "ServerGapEventLoopStall": "0",
        "ServerGapSeekLifecycleStall": "0",
        "ServerGapUnknown": "0",
    }
    assert expected.items() <= values.items()
