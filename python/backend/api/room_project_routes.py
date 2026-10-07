"""Song projects shared through a room: uploaded by their original sharer, downloaded by members."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Annotated

import anyio
from fastapi import FastAPI, Header, Request, Response
from fastapi.responses import FileResponse

from backend.api.room_server_access import room_member
from backend.domain_errors import DomainError, ForbiddenError, NotFoundError
from backend.infrastructure.ids import UuidGenerator
from backend.room.access import project_source
from backend.room.identifiers import normalize_room_id
from backend.room.ports import RoomRepository

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


async def store_project(request: Request, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{UuidGenerator().new()}.upload")
    received = 0
    try:
        async with await anyio.open_file(temporary, "wb") as output:
            async for chunk in request.stream():
                received += len(chunk)
                if received > _maximum_project_bytes:
                    raise DomainError("ProjectTooLarge", "Room project exceeds size limit", 413)
                await output.write(chunk)
        await anyio.to_thread.run_sync(os.replace, temporary, target)
    finally:
        await anyio.to_thread.run_sync(temporary.unlink, True)


def add_project_routes(app: FastAPI, repository: RoomRepository, root: Path) -> None:
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
        await store_project(request, _project_path(root, room_id, song_id, revision, participant_id))
        return Response(status_code=204)

    @app.get("/rooms/{room_id}/projects/{song_id}/{revision}")
    def download_project(
        room_id: str,
        song_id: str,
        revision: int,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> FileResponse:
        room_id = normalize_room_id(room_id)
        room = room_member(repository, room_id, participant_id)
        source = project_source(room, song_id, revision)
        target = None if source is None else _project_path(root, room_id, song_id, revision, source)
        if target is None or not target.is_file():
            raise NotFoundError("RoomProjectNotFound", "Room project has not been uploaded")
        return FileResponse(target, media_type="application/zip", filename=target.name)
