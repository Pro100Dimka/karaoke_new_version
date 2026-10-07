from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app
from backend.api.room_identity import ROOM_KEY_HEADER, participant_id_for
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


def _program_lines(root: Path) -> list[dict[str, object]]:
    return [json.loads(line) for line in (root / "program.jsonl").read_text(encoding="utf-8").splitlines()]


def test_program_logs_from_two_computers_share_one_ordered_file(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, program_log_path=tmp_path / "program.jsonl")
    keys = ("a" * 64, "b" * 64)
    with TestClient(app) as client:
        for key, source in zip(keys, ("frontend", "AudioService")):
            response = client.post(
                "/app-logs",
                headers={ROOM_KEY_HEADER: key},
                json={
                    "clientId": participant_id_for(key),
                    "entries": [
                        {
                            "timestamp": "2026-10-07T15:00:00.000Z",
                            "source": source,
                            "level": "ERROR",
                            "message": f"problem on {source}",
                        }
                    ],
                },
            )
            assert response.status_code == 204
    lines = _program_lines(tmp_path)
    assert [line["clientId"] for line in lines] == [participant_id_for(key) for key in keys]
    assert [line["source"] for line in lines] == ["frontend", "AudioService"]
    assert [line["message"] for line in lines] == [
        "problem on frontend",
        "problem on AudioService",
    ]
    assert all(line["at"] for line in lines)


def test_program_log_upload_rejects_other_identity_and_unbounded_input(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, program_log_path=tmp_path / "program.jsonl")
    key = "a" * 64
    body = {
        "clientId": participant_id_for(key),
        "entries": [
            {
                "timestamp": "2026-10-07T15:00:00.000Z",
                "source": "backend",
                "level": "ERROR",
                "message": "failure",
            }
        ],
    }
    with TestClient(app) as client:
        assert client.post("/app-logs", json=body).status_code == 403
        assert (
            client.post(
                "/app-logs", headers={ROOM_KEY_HEADER: "b" * 64}, json=body
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/app-logs",
                headers={ROOM_KEY_HEADER: key},
                json={**body, "entries": [{**body["entries"][0], "message": "x" * 4097}]},
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/app-logs",
                headers={ROOM_KEY_HEADER: key},
                json={**body, "entries": body["entries"] * 101},
            ).status_code
            == 422
        )
    assert not (tmp_path / "program.jsonl").exists()


def test_program_log_preserves_prior_entries_after_server_restart(tmp_path: Path) -> None:
    target = tmp_path / "program.jsonl"
    key = "a" * 64
    for message in ("before restart", "after restart"):
        app = create_room_server_app(relay_port=0, program_log_path=target)
        with TestClient(app) as client:
            assert (
                client.post(
                    "/app-logs",
                    headers={ROOM_KEY_HEADER: key},
                    json={
                        "clientId": participant_id_for(key),
                        "entries": [
                            {
                                "timestamp": "2026-10-07T15:00:00.000Z",
                                "source": "backend",
                                "level": "ERROR",
                                "message": message,
                            }
                        ],
                    },
                ).status_code
                == 204
            )
    assert [line["message"] for line in _program_lines(tmp_path)] == [
        "before restart",
        "after restart",
    ]


def test_program_log_keeps_recent_lines_within_single_file_limit(tmp_path: Path) -> None:
    from backend.infrastructure.room_diagnostics import ProgramLog

    target = tmp_path / "program.jsonl"
    log = ProgramLog(target, max_bytes=400)
    for number in range(10):
        log.append("client", [{"timestamp": "t", "source": "audio", "level": "INFO", "message": str(number)}])
    lines = _program_lines(tmp_path)
    assert target.stat().st_size <= 400
    assert lines[-1]["message"] == "9"
    assert lines[0]["message"] != "0"


def test_program_log_compaction_leaves_room_for_many_more_appends(tmp_path: Path) -> None:
    from backend.infrastructure.room_diagnostics import ProgramLog

    target = tmp_path / "program.jsonl"
    log = ProgramLog(target, max_bytes=1000)
    previous_size = 0
    for number in range(100):
        assert log.append(
            "client",
            [{"timestamp": "t", "source": "audio", "level": "INFO", "message": str(number)}],
        )
        size = target.stat().st_size
        if size < previous_size:
            assert size <= 500
            break
        previous_size = size
    else:
        raise AssertionError("The program log never reached its size limit")


def test_program_log_bounds_repeated_uploads_from_one_peer(tmp_path: Path) -> None:
    from backend.infrastructure.room_diagnostics import ProgramLog

    log = ProgramLog(tmp_path / "program.jsonl", max_peer_uploads_per_minute=1)
    entry = {"timestamp": "t", "source": "audio", "level": "INFO", "message": "one"}
    assert log.append("client", [entry], rate_key="203.0.113.1")
    assert not log.append("client", [entry], rate_key="203.0.113.1")
    assert len(_program_lines(tmp_path)) == 1


def test_program_log_bounds_total_uploads_across_many_peers(tmp_path: Path) -> None:
    from backend.infrastructure.room_diagnostics import ProgramLog

    log = ProgramLog(tmp_path / "program.jsonl", max_uploads_per_minute=2)
    entry = {"timestamp": "t", "source": "audio", "level": "INFO", "message": "one"}
    assert log.append("client", [entry], rate_key="203.0.113.1")
    assert log.append("client", [entry], rate_key="203.0.113.2")
    assert not log.append("client", [entry], rate_key="203.0.113.3")
    assert len(_program_lines(tmp_path)) == 2


def test_program_log_rejects_a_body_larger_than_the_transport_limit(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, program_log_path=tmp_path / "program.jsonl")
    key = "a" * 64
    with TestClient(app) as client:
        response = client.post(
            "/app-logs",
            headers={ROOM_KEY_HEADER: key},
            json={"clientId": participant_id_for(key), "entries": [], "padding": "x" * 600_000},
        )
    assert response.status_code == 413
    assert not (tmp_path / "program.jsonl").exists()


def test_room_metrics_and_server_errors_are_visible_in_program_log(tmp_path: Path) -> None:
    from backend.infrastructure.room_diagnostics import ProgramLog, ProgramLogHandler

    target = tmp_path / "program.jsonl"
    app = create_room_server_app(
        relay_port=0, diagnostics_root=tmp_path / "room-diagnostics", program_log_path=target
    )
    with TestClient(app) as client:
        room = client.post(
            "/rooms", json={"participantId": "host-1", "displayName": "Host"}
        ).json()["roomId"]
        assert (
            client.post(
                f"/rooms/{room}/diagnostics",
                json={"participantId": "host-1", "values": {"Backend": "ASIO"}},
            ).status_code
            == 204
        )
    handler = ProgramLogHandler(ProgramLog(target))
    handler.handle(logging.LogRecord("room.server", logging.ERROR, __file__, 1, "server failed", (), None))
    lines = _program_lines(tmp_path)
    assert lines[0]["source"] == "room-diagnostics"
    assert json.loads(lines[0]["message"])["Backend"] == "ASIO"
    assert lines[1]["source"] == "room.server"
    assert lines[1]["message"] == "server failed"


def test_room_server_runtime_logs_uvicorn_errors_in_program_file(tmp_path: Path, monkeypatch) -> None:
    from backend import room_server_main

    root_logger = logging.getLogger()
    previous_handlers, previous_level = root_logger.handlers[:], root_logger.level
    monkeypatch.setenv("AD_VOICE_ROOM_SERVER_DATA", str(tmp_path))
    monkeypatch.setenv("AD_VOICE_ROOM_SERVER_RELAY_PORT", "0")

    def fake_run(_app, **options):
        assert options["log_config"] is None
        logging.getLogger("uvicorn.error").error("server startup failed")

    monkeypatch.setattr(room_server_main.uvicorn, "run", fake_run)
    try:
        room_server_main.main()
    finally:
        root_logger.handlers[:] = previous_handlers
        root_logger.setLevel(previous_level)

    assert any(
        line["source"] == "uvicorn.error" and line["message"] == "server startup failed"
        for line in _program_lines(tmp_path / "logs")
    )
