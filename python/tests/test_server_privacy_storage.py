from __future__ import annotations

from pathlib import Path
import hashlib
from contextlib import nullcontext

import pytest
from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app
from backend.domain_errors import DomainError


def test_deleted_account_cannot_reappear_and_its_social_data_is_removed(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, room_database=tmp_path / "rooms.sqlite3")
    headers = {"X-AD-Voice-Device": "owner-secret-" + "a" * 32}
    with TestClient(app) as client:
        account = client.get("/social/me", headers=headers).json()
        deleted = client.request(
            "DELETE", "/social/me", headers=headers, json={"accountId": account["accountId"]}
        )
        assert deleted.status_code == 204
        assert client.get("/social/me", headers=headers).status_code == 403
        assert app.state.container.social.accounts.people((account["accountId"],)) == ()
        assert (
            client.request(
                "DELETE", "/social/me", headers=headers, json={"accountId": account["accountId"]}
            ).status_code
            == 204
        )


def test_storage_quota_reserves_parallel_uploads_and_releases_aborted_space(tmp_path: Path) -> None:
    from backend.infrastructure.room_upload_storage import RoomUploadStorage

    storage = RoomUploadStorage(tmp_path, account_bytes=10, total_bytes=30, reserve_bytes=0)
    first = tmp_path / "room" / "first.zip"
    second = tmp_path / "room" / "second.zip"
    storage.reserve(first, "account", ("singer",), 6)
    with pytest.raises(DomainError) as rejected:
        storage.reserve(second, "account", ("singer",), 5)
    assert rejected.value.code == "AccountStorageQuotaExceeded"
    storage.release(first)
    storage.reserve(second, "account", ("singer",), 5)
    storage.release(second)


def test_program_log_removes_expired_lines_without_new_uploads(tmp_path: Path) -> None:
    from backend.infrastructure.room_diagnostics import ProgramLog

    now = [1_800_000_000.0]
    path = tmp_path / "program.jsonl"
    log = ProgramLog(path, retention_days=7, now=lambda: now[0])
    assert log.append("singer", [{"message": "private old diagnostic"}])
    now[0] += 8 * 86_400
    log.cleanup()
    assert not path.exists() or not path.read_text(encoding="utf-8").strip()


def test_quota_counts_existing_files_after_restart_and_streams_without_length(
    tmp_path: Path,
) -> None:
    from backend.infrastructure.room_upload_storage import RoomUploadStorage

    directory = tmp_path / "old-room" / hashlib.sha256(b"singer").hexdigest()[:32]
    directory.mkdir(parents=True)
    (directory / "project.zip").write_bytes(b"1234567")
    storage = RoomUploadStorage(tmp_path, account_bytes=10, total_bytes=30, reserve_bytes=0)
    target = tmp_path / "new-room" / "upload.zip"
    with pytest.raises(DomainError, match="Account storage quota"):
        storage.reserve(target, "account", ("singer",), 4)
    storage.reserve(target, "account", ("singer",), 0)
    storage.grow(target, 3)
    with pytest.raises(DomainError, match="Account storage quota"):
        storage.grow(target, 4)
    storage.release(target)


def test_global_quota_is_shared_between_accounts(tmp_path: Path) -> None:
    from backend.infrastructure.room_upload_storage import RoomUploadStorage

    storage = RoomUploadStorage(tmp_path, account_bytes=20, total_bytes=10, reserve_bytes=0)
    storage.reserve(tmp_path / "first.zip", "first", ("first",), 7)
    with pytest.raises(DomainError) as rejected:
        storage.reserve(tmp_path / "second.zip", "second", ("second",), 4)
    assert rejected.value.code == "ServerStorageQuotaExceeded"


def test_project_api_rejects_excess_quota_without_damaging_an_existing_upload(
    tmp_path: Path,
) -> None:
    app = create_room_server_app(relay_port=0, project_root=tmp_path)
    app.state.upload_storage.account_bytes = 10
    with TestClient(app) as client:
        room = client.post("/rooms", json={"participantId": "host", "displayName": "Host"}).json()[
            "roomId"
        ]
        client.post(
            f"/rooms/{room}/library",
            json={
                "participantId": "host",
                "songs": [
                    {
                        "songId": song,
                        "revision": 1,
                        "title": song,
                        "artist": "Singer",
                        "durationSeconds": 10,
                    }
                    for song in ["first", "second"]
                ],
            },
        )
        headers = {"X-Participant-Id": "host"}
        assert (
            client.put(
                f"/rooms/{room}/projects/first/1", headers=headers, content=b"123456"
            ).status_code
            == 204
        )
        rejected = client.put(f"/rooms/{room}/projects/second/1", headers=headers, content=b"12345")
        assert rejected.status_code == 413
        assert rejected.json()["code"] == "AccountStorageQuotaExceeded"
        assert client.get(f"/rooms/{room}/projects/first/1", headers=headers).content == b"123456"
        assert list(tmp_path.rglob("*.upload")) == []


def test_account_deletion_erases_owned_files_and_logs_but_preserves_another_account(
    tmp_path: Path,
) -> None:
    from backend.social.codes import device_participant_id
    from backend.infrastructure.room_diagnostics import ProgramLog, RoomDiagnosticsLog
    from backend.serialization import dumps

    projects = tmp_path / "projects"
    diagnostics = RoomDiagnosticsLog(tmp_path / "diagnostics")
    program = ProgramLog(tmp_path / "program.jsonl")
    app = create_room_server_app(
        relay_port=0,
        room_database=tmp_path / "rooms.sqlite3",
        project_root=projects,
        diagnostics_root=tmp_path / "diagnostics",
        program_log=program,
    )
    secret = "delete-owner-" + "a" * 32
    participant = device_participant_id(secret)
    other_secret = "keep-owner-" + "b" * 32
    other = device_participant_id(other_secret)
    headers = {"X-AD-Voice-Device": secret}
    with TestClient(app) as client:
        account = client.get("/social/me", headers=headers).json()
        other_account = client.get("/social/me", headers={"X-AD-Voice-Device": other_secret}).json()
        accounts = app.state.container.social.accounts
        accounts.report_presence(accounts.identify(secret), "Deleted", participant, None, secret)
        accounts.report_presence(accounts.identify(other_secret), "Kept", other, None, other_secret)
        owned = (
            projects / "room" / hashlib.sha256(participant.encode()).hexdigest()[:32] / "song.zip"
        )
        kept = projects / "room" / hashlib.sha256(other.encode()).hexdigest()[:32] / "song.zip"
        for file in [owned, kept]:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(b"private project")
        membership = projects / "performances" / "room" / "1" / "members.json"
        membership.parent.mkdir(parents=True)
        membership.write_text(dumps([participant, other]), encoding="utf-8")
        program.append(participant, [{"message": "erase this log"}])
        program.append(other, [{"message": "keep this log"}])
        diagnostics.append("room", participant, {"metric": "1"})
        response = client.request(
            "DELETE", "/social/me", headers=headers, json={"accountId": account["accountId"]}
        )
        assert response.status_code == 204
        assert not owned.exists()
        assert kept.exists()
        assert participant not in membership.read_text(encoding="utf-8")
        assert "erase this log" not in (tmp_path / "program.jsonl").read_text(encoding="utf-8")
        assert "keep this log" in (tmp_path / "program.jsonl").read_text(encoding="utf-8")
        assert (
            client.get("/social/me", headers={"X-AD-Voice-Device": other_secret}).json()[
                "accountId"
            ]
            == other_account["accountId"]
        )


def test_disabled_identity_stays_disabled_without_contacting_the_server(monkeypatch) -> None:
    from backend.infrastructure import account_identity

    records: dict[str, str] = {}

    class Credentials:
        def __init__(self, target: str) -> None:
            self.target = target

        def locked(self):
            return nullcontext()

        def read(self):
            return records.get(self.target)

        def write(self, value):
            records[self.target] = value

    monkeypatch.setattr(account_identity, "WindowsCredentials", Credentials)
    monkeypatch.setattr(
        account_identity,
        "_request",
        lambda *_: pytest.fail("A disabled identity must not recreate an account"),
    )
    disabled = account_identity.account_identity(
        "https://rooms.example", "guest", "legacy", "disable"
    )
    assert disabled["enabled"] is False
    assert account_identity.account_identity("https://rooms.example", "guest", "legacy") == disabled
    created = account_identity.account_identity(
        "https://rooms.example", "guest", "legacy", "create"
    )
    assert created["enabled"] is True
    assert created["secret"] != disabled["secret"]
