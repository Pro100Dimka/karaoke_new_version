from __future__ import annotations

from pathlib import Path
import hashlib
import hmac
import json
import sqlite3
from contextlib import nullcontext

import pytest
from fastapi.testclient import TestClient

from backend.api.room_server_app import create_room_server_app
from backend.domain_errors import DomainError

pytestmark = pytest.mark.transfer_consent_boundary


def _choice(client: TestClient, secret: str, purpose: str, enabled: bool):
    from backend.infrastructure.transfer_consent import CONSENT_VERSION

    return client.put(
        f"/social/privacy/{purpose}",
        headers={"X-AD-Voice-Device": secret},
        json={"enabled": enabled, "version": CONSENT_VERSION},
    )


def _user(client: TestClient, secret: str):
    from backend.social.codes import device_participant_id

    assert _choice(client, secret, "online", True).status_code == 204
    key = hmac.new(secret.encode(), b"ad-voice-room-key", hashlib.sha256).hexdigest()
    headers = {"X-AD-Voice-Device": secret, "X-AD-Voice-Room-Key": key}
    account = client.get("/social/me", headers=headers).json()["accountId"]
    return headers, device_participant_id(secret), account


@pytest.mark.real_room_keys
def test_online_identity_requires_separate_transfer_choice(tmp_path: Path) -> None:
    app = create_room_server_app(
        relay_port=0,
        room_database=tmp_path / "rooms.sqlite3",
        project_root=tmp_path / "projects",
        diagnostics_root=tmp_path / "diagnostics",
    )
    headers = {"X-AD-Voice-Device": "privacy-owner-" + "a" * 32}
    with TestClient(app) as client:
        assert client.get("/social/me", headers=headers).status_code == 403
        from backend.infrastructure.transfer_consent import CONSENT_VERSION

        assert (
            client.put(
                "/social/privacy/online", headers=headers, json={"enabled": True, "version": "old"}
            ).status_code
            == 403
        )
        assert (
            client.put(
                "/social/privacy/online",
                headers=headers,
                json={"enabled": True, "version": CONSENT_VERSION},
            ).status_code
            == 204
        )
        assert client.get("/social/me", headers=headers).status_code == 200


def test_deleted_account_cannot_reappear_and_its_social_data_is_removed(tmp_path: Path) -> None:
    app = create_room_server_app(relay_port=0, room_database=tmp_path / "rooms.sqlite3")
    headers = {"X-AD-Voice-Device": "owner-secret-" + "a" * 32}
    with TestClient(app) as client:
        assert _choice(client, headers["X-AD-Voice-Device"], "online", True).status_code == 204
        account = client.get("/social/me", headers=headers).json()
        assert _choice(client, headers["X-AD-Voice-Device"], "online", False).status_code == 204
        deleted = client.request("DELETE", "/social/me", headers=headers, json={"accountId": ""})
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
    from backend.infrastructure.transfer_consent import CONSENT_VERSION

    app.state.transfer_consent.record("host", "online", True, CONSENT_VERSION)
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

        def upload(song: str, content: bytes):
            route = f"/rooms/{room}/projects/{song}/1"
            ticket = app.state.transfer_consent.declare("host", "online", route, "nonpersonal", "")
            return client.put(
                route, headers={**headers, "X-AD-Voice-File-Declaration": ticket}, content=content
            )

        assert upload("first", b"123456").status_code == 204
        rejected = upload("second", b"12345")
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
        assert _choice(client, secret, "online", True).status_code == 204
        assert _choice(client, other_secret, "online", True).status_code == 204
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


@pytest.mark.real_room_keys
def test_withdrawal_leaves_room_revokes_voice_cancels_jobs_and_invalidates_uploads(
    tmp_path: Path,
) -> None:
    from backend.infrastructure.transfer_consent import CONSENT_VERSION

    processing = tmp_path / "processing"
    processing.mkdir()
    app = create_room_server_app(
        relay_port=0,
        room_database=tmp_path / "rooms.sqlite3",
        project_root=tmp_path / "projects",
        diagnostics_root=tmp_path / "logs",
        processing_root=processing,
    )
    secret, other = "withdraw-owner-" + "a" * 32, "remaining-owner-" + "b" * 32
    with TestClient(app) as client:
        headers, participant, account = _user(client, secret)
        other_headers, other_participant, _ = _user(client, other)
        room = client.post(
            "/rooms", headers=headers, json={"participantId": participant, "displayName": "Owner"}
        ).json()["roomId"]
        assert (
            client.post(
                f"/rooms/{room}/join",
                headers=other_headers,
                json={"participantId": other_participant, "displayName": "Other"},
            ).status_code
            == 200
        )
        voice = client.post(
            "/voice/join", headers=headers, json={"roomId": room, "participantId": participant}
        ).json()["voiceToken"]
        assert _choice(client, secret, "processing", True).status_code == 204
        ticket = app.state.transfer_consent.declare(participant, "online", "/rooms/file", "own", "")
        with sqlite3.connect(processing / "queue.sqlite3") as db:
            db.execute("CREATE TABLE jobs (id TEXT,owner TEXT,state TEXT)")
            db.execute("INSERT INTO jobs VALUES ('job',?,'running')", (participant,))
        assert _choice(client, secret, "online", False).status_code == 204
        assert client.get("/social/me", headers=headers).status_code == 403
        assert app.state.container.social.accounts.person(account).account_id == account
        with sqlite3.connect(processing / "queue.sqlite3") as db:
            assert db.execute("SELECT state FROM jobs").fetchone()[0] == "cancelled"
        assert app.state.transfer_consent.revision(participant, "processing") == ""
        assert client.get(f"/rooms/{room}", headers=other_headers).status_code == 200
        assert _choice(client, secret, "online", True).status_code == 204
        assert (
            client.post(
                f"/rooms/{room}/join",
                headers=headers,
                json={"participantId": participant, "displayName": "Owner"},
            ).status_code
            == 200
        )
        rejected = client.post(
            "/voice/metrics",
            headers=headers,
            json={"roomId": room, "participantId": participant, "voiceToken": voice},
        )
        assert rejected.status_code == 403
        assert rejected.json()["code"] == "RoomVoiceTokenInvalid"
        with pytest.raises(DomainError):
            app.state.transfer_consent.require_file(ticket, participant, "online", "/rooms/file")
        with sqlite3.connect(tmp_path / "transfer-consent.sqlite3") as db:
            receipts = db.execute(
                "SELECT version,enabled,notice_hash FROM consent_receipts WHERE owner=? AND purpose='online' ORDER BY recorded",
                (participant,),
            ).fetchall()
            assert [row[1] for row in receipts] == [1, 0, 1]
            assert all(row[0] == CONSENT_VERSION and len(row[2]) == 64 for row in receipts)
            assert "Ukraine" in db.execute("SELECT notice FROM consent_notices").fetchone()[0]


@pytest.mark.real_room_keys
def test_diagnostics_minimize_automatic_data_and_require_scoped_permission_evidence(
    tmp_path: Path,
) -> None:
    path = tmp_path / "program.jsonl"
    app = create_room_server_app(
        relay_port=0,
        room_database=tmp_path / "rooms.sqlite3",
        project_root=tmp_path / "projects",
        diagnostics_root=tmp_path / "logs",
        program_log_path=path,
    )
    secret = "diagnostic-owner-" + "a" * 32
    with TestClient(app) as client:
        headers, participant, _ = _user(client, secret)
        body = {
            "clientId": participant,
            "entries": [
                {
                    "timestamp": "2026-11-26T12:00:00Z",
                    "source": "python",
                    "level": "error",
                    "message": "ValueError status=500 Alice alice@example.com D:\\Private\\voice.wav",
                }
            ],
        }
        assert client.post("/app-logs", headers=headers, json=body).status_code == 403
        assert _choice(client, secret, "diagnostics", True).status_code == 204
        assert client.post("/app-logs", headers=headers, json=body).status_code == 204
        stored = json.loads(path.read_text(encoding="utf-8").splitlines()[0])
        assert stored["message"] == "ValueError status=500"
        assert "Alice" not in path.read_text(encoding="utf-8")
        declaration = {"purpose": "diagnostics", "resource": "/app-logs", "category": "others"}
        assert (
            client.post("/social/privacy/files", headers=headers, json=declaration).status_code
            == 403
        )
        declaration["evidence"] = "sha256:" + "a" * 64
        ticket = client.post("/social/privacy/files", headers=headers, json=declaration).json()[
            "ticket"
        ]
        body["entries"][0]["declaration"] = ticket
        body["entries"][0]["message"] = (
            "Report from alice@example.com about https://example.com/private token=secret-value"
        )
        assert client.post("/app-logs", headers=headers, json=body).status_code == 204
        assert "alice@example.com" not in path.read_text(encoding="utf-8")
        assert "secret-value" not in path.read_text(encoding="utf-8")
        assert "https://example.com" not in path.read_text(encoding="utf-8")
        with pytest.raises(DomainError):
            app.state.transfer_consent.require_file(ticket, participant, "online", "/app-logs")
        assert _choice(client, secret, "diagnostics", False).status_code == 204
        assert client.post("/app-logs", headers=headers, json=body).status_code == 403


def test_export_excludes_other_people_and_old_text_and_is_erased_with_account(
    tmp_path: Path,
) -> None:
    from backend.infrastructure.transfer_consent import TransferConsent, CONSENT_VERSION
    from backend.infrastructure.room_diagnostics import ProgramLog

    consent = TransferConsent(tmp_path / "transfer-consent.sqlite3")
    owner, other = "a" * 32, "b" * 32
    for participant in [owner, other]:
        for purpose in ["online", "diagnostics"]:
            consent.record(participant, purpose, True, CONSENT_VERSION)
    log = ProgramLog(tmp_path / "program.jsonl")
    revision = consent.export_revision(owner, "support-request")
    log.append(owner, [{"message": "Historical private text"}])
    log.append(
        other,
        [{"message": "Another person's text"}],
        consent_revision=consent.require(other, "diagnostics"),
    )
    log.append(owner, [{"message": "ValueError status=500 Alice"}], consent_revision=revision)

    def allowed():
        return consent.export_revision(owner, "support-request")

    output = consent.export_path(owner, "support-request")
    assert log.export(owner, output, revision, allowed) == 1
    data = output.read_text(encoding="utf-8")
    assert "ValueError status=500" in data
    assert all(value not in data for value in ["Historical", "Another", "Alice", other])
    with pytest.raises(DomainError):
        consent.export_revision(owner, "whole-database")
    consent.record(owner, "diagnostics", False, CONSENT_VERSION)
    with pytest.raises(DomainError):
        log.export(owner, tmp_path / "blocked.jsonl", revision, allowed)
    assert not (tmp_path / "blocked.jsonl").exists()
    consent.erase((owner,))
    assert not output.exists()
    assert consent.require(other, "diagnostics")


def test_archive_range_support_and_withdrawal_during_stream(tmp_path: Path) -> None:
    import asyncio
    from backend.api.room_server_access import ConsentedFileResponse
    from backend.infrastructure.transfer_consent import TransferConsent, CONSENT_VERSION
    from fastapi import FastAPI

    consent = TransferConsent(tmp_path / "transfer-consent.sqlite3")
    owner = "a" * 32
    consent.record(owner, "online", True, CONSENT_VERSION)
    source = tmp_path / "archive.zip"
    source.write_bytes(b"x" * (256 * 1024))

    def allowed():
        return consent.require(owner, "online")

    app = FastAPI()

    @app.get("/archive")
    def archive():
        return ConsentedFileResponse(source, allowed)

    with TestClient(app) as client:
        result = client.get("/archive", headers={"Range": "bytes=10-19"})
        assert result.status_code == 206 and result.content == b"x" * 10
    sent = []

    async def send(message):
        if message["type"] == "http.response.body":
            sent.append(message.get("body", b""))
            consent.record(owner, "online", False, CONSENT_VERSION)

    async def receive():
        return {"type": "http.request", "body": b""}

    with pytest.raises(DomainError):
        asyncio.run(
            ConsentedFileResponse(source, allowed)(
                {
                    "type": "http",
                    "method": "GET",
                    "headers": [],
                    "extensions": {"http.response.pathsend": {}},
                },
                receive,
                send,
            )
        )
    assert 0 < sum(map(len, sent)) < source.stat().st_size
