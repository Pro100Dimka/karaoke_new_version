"""Song projects shared through a room: uploaded by their original sharer, downloaded by members."""

from __future__ import annotations

import hashlib
import os
import re
from functools import partial
from pathlib import Path
from typing import Annotated, Callable, NotRequired, TypedDict
from uuid import UUID
from threading import Lock

import anyio
from fastapi import FastAPI, Header, Request, Response
from fastapi.responses import FileResponse

from backend.serialization import dumps, loads_list
from backend.api.room_server_access import room_member, ConsentedFileResponse
from backend.domain_errors import DomainError, ForbiddenError, NotFoundError
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.atomic_files import atomic_write_text
from backend.room.access import project_source
from backend.room.identifiers import normalize_room_id
from backend.room.ports import RoomRepository
from backend.room.performance import performance_result

_maximum_project_bytes = 8 * 1024 * 1024 * 1024
_safe_project_component = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


def _project_name(song_id: str, revision: int) -> str:
    if not _safe_project_component.fullmatch(song_id) or revision < 1:
        raise DomainError("ValidationError", "Invalid room project identity", 422)
    return f"{song_id}-r{revision}.advoice.zip"


def _project_path(root: Path, room_id: str, song_id: str, revision: int, uploader: str) -> Path:
    """Each member's upload is a file of its own, so no upload can overwrite another member's."""
    folder = hashlib.sha256(uploader.encode()).hexdigest()[:32]
    return root / room_id / folder / _project_name(song_id, revision)


async def store_project(
    request: Request,
    target: Path,
    on_progress: Callable[[int], None] | None = None,
) -> None:
    temporary = target.with_name(f".{target.name}.{UuidGenerator().new()}.upload")
    storage = getattr(request.app.state, "upload_storage", None) if "app" in request.scope else None
    declared = request.headers.get("content-length") if "headers" in request.scope else None
    expected = int(declared) if declared is not None else None
    consent = request.app.state.transfer_consent
    participant = request.headers.get("X-Participant-Id", "")
    declaration = request.headers.get("X-AD-Voice-File-Declaration", "")
    await anyio.to_thread.run_sync(
        partial(consent.require_file, declaration, participant, "online", request.url.path)
    )
    if storage is not None:
        participant_id = request.headers["X-Participant-Id"]
        accounts = request.app.state.container.social.accounts
        owner, participants = await anyio.to_thread.run_sync(accounts.storage_owner, participant_id)
        await anyio.to_thread.run_sync(storage.reserve, target, owner, participants, expected or 0)
    received = 0
    try:
        await anyio.to_thread.run_sync(partial(target.parent.mkdir, parents=True, exist_ok=True))
        async with await anyio.open_file(temporary, "wb") as output:
            async for chunk in request.stream():
                await anyio.to_thread.run_sync(
                    partial(
                        consent.require_file, declaration, participant, "online", request.url.path
                    )
                )
                received += len(chunk)
                if received > _maximum_project_bytes:
                    raise DomainError("ProjectTooLarge", "Room project exceeds size limit", 413)
                if expected is not None and received > expected:
                    raise DomainError("UploadSizeMismatch", "Upload exceeds declared size", 400)
                if storage is not None:
                    await anyio.to_thread.run_sync(storage.grow, target, received)
                await output.write(chunk)
                if on_progress:
                    on_progress(received)
        if expected is not None and received != expected:
            raise DomainError("UploadSizeMismatch", "Upload does not match declared size", 400)
        await anyio.to_thread.run_sync(
            partial(consent.require_file, declaration, participant, "online", request.url.path)
        )
        if storage is None:
            await anyio.to_thread.run_sync(os.replace, temporary, target)
        else:
            await anyio.to_thread.run_sync(storage.commit, target, temporary)
    finally:
        with anyio.CancelScope(shield=True):
            await anyio.to_thread.run_sync(temporary.unlink, True)
            if storage is not None:
                await anyio.to_thread.run_sync(storage.release, target)


async def _tracked_upload(
    request: Request,
    target: Path,
    uploads: dict[Path, tuple[object, int, int]],
) -> None:
    try:
        total = int(request.headers.get("content-length", "0"))
    except ValueError as exc:
        raise DomainError("ValidationError", "Invalid project content length", 422) from exc
    if total < 0 or total > _maximum_project_bytes:
        raise DomainError("ProjectTooLarge", "Room project exceeds size limit", 413)
    if target in uploads:
        raise DomainError("UploadInProgress", "This file is already being uploaded", 409)
    token = object()
    uploads[target] = (token, 0, total)

    def moved(received: int) -> None:
        if uploads.get(target, (None, 0, 0))[0] is token:
            uploads[target] = (token, received, total)

    try:
        await store_project(request, target, moved)
    finally:
        if uploads.get(target, (None, 0, 0))[0] is token:
            uploads.pop(target, None)


def add_project_routes(app: FastAPI, repository: RoomRepository, root: Path) -> None:
    uploads: dict[Path, tuple[object, int, int]] = {}

    @app.put("/rooms/{room_id}/projects/{song_id}/{revision}", status_code=204)
    async def upload_project(
        room_id: str,
        song_id: str,
        revision: int,
        request: Request,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> Response:
        room_id = normalize_room_id(room_id)
        room = await anyio.to_thread.run_sync(room_member, repository, room_id, participant_id)
        if project_source(room, song_id, revision) != participant_id:
            raise ForbiddenError("RoomPermissionDenied", "Only the song owner may upload it")
        await _tracked_upload(
            request,
            _project_path(root, room_id, song_id, revision, participant_id),
            uploads,
        )
        return Response(status_code=204)

    @app.get("/rooms/{room_id}/projects/{song_id}/{revision}")
    async def download_project(
        room_id: str,
        song_id: str,
        revision: int,
        request: Request,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> FileResponse:
        room_id = normalize_room_id(room_id)
        room = await anyio.to_thread.run_sync(room_member, repository, room_id, participant_id)
        source = project_source(room, song_id, revision)
        target = None if source is None else _project_path(root, room_id, song_id, revision, source)
        target = await _downloadable_project(target, uploads)
        return ConsentedFileResponse(
            target,
            lambda: request.app.state.transfer_consent.require(participant_id, "online"),
            filename=target.name,
        )


async def _downloadable_project(
    target: Path | None, uploads: dict[Path, tuple[object, int, int]]
) -> Path:
    pending = uploads.get(target) if target is not None else None
    available = False
    if target is not None and pending is None:
        available = await anyio.to_thread.run_sync(target.is_file)
        # An upload may have started while the filesystem worker checked an older file.
        pending = uploads.get(target)
    if pending is not None or target is None or not available:
        details = {"uploadBytes": pending[1], "uploadTotalBytes": pending[2]} if pending else {}
        raise NotFoundError("RoomProjectNotFound", "Room project has not been uploaded", **details)
    return target


def _performance_members(
    repository: RoomRepository, root: Path, room_id: str, performance_id: int, actor_id: str
) -> set[str]:
    room = repository.get(room_id)
    membership = root / room_id / str(performance_id) / "members.json"
    members = (
        set(loads_list(membership.read_text(encoding="utf-8"))) if membership.is_file() else set()
    )
    stored = set(members)
    if room is not None:
        members.update(room.performance_history.get(performance_id, {}))
        if performance_id == room.performance_id and room.song_id is not None:
            members.update(room.participants)
    if not members:
        raise NotFoundError("RoomPerformanceNotFound", "Room performance was not found")
    if actor_id not in members:
        raise ForbiddenError(
            "RoomPermissionDenied", "Only this performance's members may access its sources"
        )
    if members != stored:
        atomic_write_text(membership, dumps(sorted(members)))
    return members


def _performance_source_path(
    root: Path, room_id: str, performance_id: int, singer: str, capture_id: str | None = None
) -> Path:
    target = (
        root / room_id / str(performance_id) / f"{hashlib.sha256(singer.encode()).hexdigest()}.zip"
    )
    if capture_id is None:
        return target
    try:
        capture = str(UUID(capture_id))
    except ValueError as exc:
        raise DomainError("ValidationError", "Invalid singer capture identity", 422) from exc
    return target.with_suffix("") / f"{capture}.zip"


class _FileStatus(TypedDict):
    available: bool
    sizeBytes: int
    uploadBytes: NotRequired[int]
    uploadTotalBytes: NotRequired[int]


class _CaptureStatus(_FileStatus):
    captureId: str


class _PerformanceSources:
    def __init__(self, repository: RoomRepository, root: Path) -> None:
        self.repository = repository
        self.root = root
        self.uploads: dict[Path, tuple[object, int, int]] = {}
        self.membership_lock = Lock()

    def _retained_members(self, room_id: str, performance_id: int, actor_id: str) -> set[str]:
        with self.membership_lock:
            return _performance_members(
                self.repository, self.root, room_id, performance_id, actor_id
            )

    async def members(
        self, room_id: str, performance_id: int, actor_id: str
    ) -> tuple[str, set[str]]:
        room_id = normalize_room_id(room_id)
        if performance_id < 1:
            raise NotFoundError("RoomPerformanceNotFound", "Room performance was not found")
        singers = await anyio.to_thread.run_sync(
            partial(self._retained_members, room_id, performance_id, actor_id)
        )
        return room_id, singers

    async def upload_source(
        self,
        room_id: str,
        performance_id: int,
        singer: str,
        request: Request,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
        capture_id: str | None = None,
    ) -> Response:
        room_id, _ = await self.members(room_id, performance_id, participant_id)
        if singer != participant_id:
            raise ForbiddenError(
                "RoomPermissionDenied", "A singer may upload only their own source"
            )
        target = _performance_source_path(self.root, room_id, performance_id, singer, capture_id)
        membership = self.root / room_id / str(performance_id) / "members.json"
        if request.headers.get("content-length") == "0":

            def silent_source() -> None:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.touch(exist_ok=True)
                target.with_suffix(".pending").unlink(missing_ok=True)
                membership.touch()

            await anyio.to_thread.run_sync(silent_source)
        else:
            await _tracked_upload(request, target, self.uploads)
            await anyio.to_thread.run_sync(target.with_suffix(".pending").unlink, True)
            await anyio.to_thread.run_sync(membership.touch)
        return Response(status_code=204)

    async def begin_capture(
        self,
        room_id: str,
        performance_id: int,
        singer: str,
        capture_id: str,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> Response:
        room_id, _ = await self.members(room_id, performance_id, participant_id)
        if singer != participant_id:
            raise ForbiddenError("RoomPermissionDenied", "A singer may open only their own capture")
        target = _performance_source_path(self.root, room_id, performance_id, singer, capture_id)

        def prepare() -> None:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.is_file():
                target.with_suffix(".pending").touch(exist_ok=True)
            (self.root / room_id / str(performance_id) / "members.json").touch()

        await anyio.to_thread.run_sync(prepare)
        return Response(status_code=204)

    def _file_status(self, target: Path) -> _FileStatus:
        uploading = self.uploads.get(target)
        available = (
            uploading is None and not target.with_suffix(".pending").exists() and target.is_file()
        )
        result: _FileStatus = {
            "available": available,
            "sizeBytes": target.stat().st_size if available else 0,
        }
        if uploading:
            result.update({"uploadBytes": uploading[1], "uploadTotalBytes": uploading[2]})
        return result

    def _captures(self, target: Path) -> list[_CaptureStatus]:
        directory = target.with_suffix("")
        identities = sorted(
            {path.stem for suffix in ("*.zip", "*.pending") for path in directory.glob(suffix)}
        )
        captures = []
        for identity in identities:
            item: _CaptureStatus = {
                "captureId": identity,
                **self._file_status(directory / f"{identity}.zip"),
            }
            captures.append(item)
        return captures

    def _singer_source(self, room_id: str, performance_id: int, singer: str) -> dict[str, object]:
        target = _performance_source_path(self.root, room_id, performance_id, singer)
        result: dict[str, object] = {"participantId": singer, **self._file_status(target)}
        captures = self._captures(target)
        if captures:
            result.update(
                captures=captures,
                available=all(capture["available"] for capture in captures),
                sizeBytes=sum(capture["sizeBytes"] for capture in captures),
            )
        return result

    def _manifest(self, room_id: str, performance_id: int, singers: set[str]) -> dict[str, object]:
        room = self.repository.get(room_id)
        return {
            "participants": [
                self._singer_source(room_id, performance_id, singer) for singer in sorted(singers)
            ],
            "complete": room is None
            or room.song_id is None
            or performance_id != room.performance_id
            or performance_result(room, performance_id)["complete"],
        }

    async def list_sources(
        self,
        room_id: str,
        performance_id: int,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> dict[str, object]:
        room_id, singers = await self.members(room_id, performance_id, participant_id)
        return await anyio.to_thread.run_sync(
            partial(self._manifest, room_id, performance_id, singers)
        )

    async def download_source(
        self,
        room_id: str,
        performance_id: int,
        singer: str,
        request: Request,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
        capture_id: str | None = None,
    ) -> FileResponse:
        room_id, singers = await self.members(room_id, performance_id, participant_id)
        if singer not in singers:
            raise NotFoundError("RoomPerformanceSourceNotFound", "Singer source was not found")
        target = await _downloadable_project(
            _performance_source_path(self.root, room_id, performance_id, singer, capture_id),
            self.uploads,
        )
        return ConsentedFileResponse(
            target,
            lambda: request.app.state.transfer_consent.require(participant_id, "online"),
            filename="room-source.zip",
        )


def add_performance_source_routes(app: FastAPI, repository: RoomRepository, root: Path) -> None:
    sources = _PerformanceSources(repository, root)
    base = "/rooms/{room_id}/performances/{performance_id}/sources"
    capture = "/{singer}/captures/{capture_id}"
    routes: list[tuple[str, str, Callable[..., object]]] = [
        ("", "GET", sources.list_sources),
        ("/{singer}", "PUT", sources.upload_source),
        ("/{singer}", "GET", sources.download_source),
        (capture, "POST", sources.begin_capture),
        (capture, "PUT", sources.upload_source),
        (capture, "GET", sources.download_source),
    ]
    for suffix, method, endpoint in routes:
        app.add_api_route(
            base + suffix,
            endpoint,
            methods=[method],
            status_code=204 if method in ["POST", "PUT"] else 200,
        )
