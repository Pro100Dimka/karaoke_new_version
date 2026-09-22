from __future__ import annotations

import asyncio
import logging
import os
import re
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from typing import Annotated, AsyncIterator, Callable
from pathlib import Path

import anyio
from fastapi import FastAPI, Request
from fastapi import Header, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.errors import domain_error_response
from backend.api.middleware import RequestIdentityMiddleware
from backend.api.room_routes import router as room_router
from backend.bootstrap.container import RoomCases
from backend.bootstrap.room_wiring import build_room_cases
from backend.domain_errors import DomainError, ForbiddenError, NotFoundError
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.sqlite_rooms import SqliteRoomRepository
from backend.room.ports import RoomRepository
from backend.room.domain import Room
from backend.infrastructure.voice_relay import VoiceRelay
from backend.room.identifiers import normalize_room_id

logger = logging.getLogger(__name__)

_sweep_interval_seconds = 2.0
_default_relay_port = 40000
_maximum_project_bytes = 8 * 1024 * 1024 * 1024
_safe_project_component = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class VoiceJoinDto(ApiModel):
    room_id: str = Field(min_length=1, max_length=128)
    participant_id: str = Field(min_length=1, max_length=128)


class VoiceLeaveDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)


class VoiceJoinResponse(ApiModel):
    voice_token: str


@dataclass(frozen=True, slots=True)
class RoomServerContainer:
    """Stands in for the desktop app's ``ApplicationContainer``: room_routes only ever reads ``.rooms`` from it."""

    rooms: RoomCases


async def _sweep_host_disconnects(
    cases: RoomCases, repository: InMemoryRoomRepository | SqliteRoomRepository
) -> None:
    """Runs the same host-failover the desktop app would trigger by polling; here nothing else calls it."""
    while True:
        await asyncio.sleep(_sweep_interval_seconds)
        for room_id in repository.list_ids():
            try:
                cases.resolve_host_disconnect.execute(room_id)
            except DomainError:
                continue


def _resolve_relay_port(relay_port: int | None) -> int:
    if relay_port is not None:
        return relay_port
    return int(os.getenv("AD_VOICE_ROOM_SERVER_RELAY_PORT", str(_default_relay_port)))


def _lifespan_for(
    container: RoomServerContainer,
    cases: RoomCases,
    repository: InMemoryRoomRepository | SqliteRoomRepository,
    relay: VoiceRelay,
    relay_port: int,
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.container = container
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: relay, local_addr=("0.0.0.0", relay_port)
        )
        sweep = asyncio.create_task(_sweep_host_disconnects(cases, repository))
        try:
            yield
        finally:
            sweep.cancel()
            transport.close()

    return lifespan


def _add_voice_routes(app: FastAPI, relay: VoiceRelay, repository: RoomRepository) -> None:
    @app.post("/voice/join", response_model=VoiceJoinResponse)
    def voice_join(body: VoiceJoinDto) -> VoiceJoinResponse:
        room_id = normalize_room_id(body.room_id)
        room = repository.get(room_id)
        if room is None:
            raise NotFoundError("RoomNotFound", "Room was not found", roomId=body.room_id)
        if body.participant_id not in room.participants:
            raise NotFoundError(
                "ParticipantNotFound",
                "Room participant was not found",
                participantId=body.participant_id,
            )
        token = relay.expect(room_id, body.participant_id)
        return VoiceJoinResponse(voice_token=f"{token:016x}")

    @app.post("/voice/leave", status_code=204)
    def voice_leave(body: VoiceLeaveDto) -> None:
        relay.forget(body.participant_id)


def _project_path(root: Path, room_id: str, song_id: str, revision: int) -> Path:
    if not _safe_project_component.fullmatch(song_id) or revision < 1:
        raise DomainError("ValidationError", "Invalid room project identity", 422)
    return root / room_id / f"{song_id}-r{revision}.advoice.zip"


def _room_member(repository: RoomRepository, room_id: str, participant_id: str) -> Room:
    room = repository.get(room_id)
    if room is None:
        raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
    if participant_id not in room.participants:
        raise ForbiddenError("RoomPermissionDenied", "Participant is not in this room")
    return room


async def _store_project(request: Request, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".upload")
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


def _add_project_routes(app: FastAPI, repository: RoomRepository, root: Path) -> None:
    @app.put("/rooms/{room_id}/projects/{song_id}/{revision}", status_code=204)
    async def upload_project(
        room_id: str,
        song_id: str,
        revision: int,
        request: Request,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> Response:
        room_id = normalize_room_id(room_id)
        room = _room_member(repository, room_id, participant_id)
        owned = any(
            song.owner_participant_id == participant_id
            and song.song_id == song_id
            and song.revision == revision
            for song in room.shared_songs
        )
        if not owned:
            raise ForbiddenError("RoomPermissionDenied", "Only the song owner may upload it")
        await _store_project(request, _project_path(root, room_id, song_id, revision))
        return Response(status_code=204)

    @app.get("/rooms/{room_id}/projects/{song_id}/{revision}")
    def download_project(
        room_id: str,
        song_id: str,
        revision: int,
        participant_id: Annotated[str, Header(alias="X-Participant-Id")],
    ) -> FileResponse:
        room_id = normalize_room_id(room_id)
        _room_member(repository, room_id, participant_id)
        target = _project_path(root, room_id, song_id, revision)
        if not target.is_file():
            raise NotFoundError("RoomProjectNotFound", "Room project has not been uploaded")
        return FileResponse(target, media_type="application/zip", filename=target.name)


def create_room_server_app(
    *,
    relay_port: int | None = None,
    room_database: Path | None = None,
    project_root: Path | None = None,
) -> FastAPI:
    """A standalone service exposing only the room subsystem, meant to run on a server every client can reach.

    Song, recording and AI data stay local to each user's own desktop backend; only room signaling (who is in a
    room, whose turn it is to host, which song was picked) is shared, so this app wires nothing from those areas.
    ``relay_port`` 0 asks the OS for a free port, which is what tests that run more than one instance want.
    """
    # The repository is built here (not inside build_room_cases) so the sweep task can list its room ids directly.
    repository = (
        SqliteRoomRepository(room_database)
        if room_database is not None
        else InMemoryRoomRepository()
    )
    cases = build_room_cases(UuidGenerator(), UtcClock(), repository)
    relay = VoiceRelay()
    lifespan = _lifespan_for(
        RoomServerContainer(cases), cases, repository, relay, _resolve_relay_port(relay_port)
    )

    app = FastAPI(title="A&D Voice Room Server", lifespan=lifespan)
    app.add_middleware(RequestIdentityMiddleware, ids=UuidGenerator())
    app.add_exception_handler(DomainError, _domain_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _internal_error)
    app.include_router(room_router)

    @app.get("/health/ready")
    def health() -> dict[str, bool]:
        return {"ok": True}

    _add_voice_routes(app, relay, repository)
    _add_project_routes(app, repository, project_root or Path("./room-projects"))
    return app


async def _domain_error(request: Request, error: Exception) -> JSONResponse:
    if not isinstance(error, DomainError):
        return await _internal_error(request, error)
    return domain_error_response(request, error)


async def _validation_error(request: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, RequestValidationError)
    return JSONResponse(
        status_code=422,
        content={
            "code": "ValidationError",
            "message": "Request validation failed",
            "details": {"errors": error.errors()},
            "requestId": getattr(request.state, "request_id", None),
        },
    )


async def _internal_error(request: Request, error: Exception) -> JSONResponse:
    logger.exception("Unhandled room server error", exc_info=error)
    return JSONResponse(
        status_code=500,
        content={"code": "InternalError", "message": "Internal room server error", "details": {}},
    )
