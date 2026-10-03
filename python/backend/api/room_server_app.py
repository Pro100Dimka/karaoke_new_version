from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from functools import partial
from typing import Annotated, AsyncIterator, Awaitable, Callable
from pathlib import Path

import anyio
from fastapi import FastAPI, Query, Request
from fastapi import Header, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.errors import domain_error_response
from backend.api.middleware import RequestIdentityMiddleware
from backend.api.room_routes import _room, router as room_router
from backend.api.social_server import add_social_routes, build_room_server_social, start_social
from backend.bootstrap.room_wiring import RoomCases, build_room_cases
from backend.bootstrap.social_wiring import SocialCases
from backend.domain_errors import DomainError, ForbiddenError, NotFoundError
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.sqlite_rooms import SqliteRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.infrastructure.room_activity import RoomActivity
from backend.infrastructure.room_departures import RoomDepartures
from backend.infrastructure.room_project_folders import RoomProjectFolders
from backend.infrastructure.room_diagnostics import RoomDiagnosticsLog
from backend.room.ports import RoomRepository
from backend.room.domain import ConnectionState, Room
from backend.infrastructure.voice_relay import RelaySocket, VoiceRelay
from backend.room.identifiers import normalize_room_id

logger = logging.getLogger(__name__)

_sweep_interval_seconds = 2.0
# A room no client has asked about for this long is abandoned (an open app long-polls every 25 s).
_abandoned_room_seconds = 3600.0
# An app that closed without leaving its room is taken out of it after this long: twice the longest
# pause between the app's attempts to reconnect its socket (30 s), so a restart or a network hiccup
# never costs anyone their place.
_departure_grace_seconds = 60.0
_room_path = re.compile(r"^/rooms/([^/]+)")
_default_relay_port = 40000
_maximum_project_bytes = 8 * 1024 * 1024 * 1024
_safe_project_component = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


class VoiceJoinDto(ApiModel):
    room_id: str = Field(min_length=1, max_length=128)
    participant_id: str = Field(min_length=1, max_length=128)
    machine_id: str = Field(default="", max_length=128)


class VoiceLeaveDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)


class VoiceJoinResponse(ApiModel):
    voice_token: str


class VoiceCandidateDto(VoiceJoinDto):
    voice_token: str = Field(pattern=r"^[0-9a-fA-F]{16}$")
    local_port: int = Field(ge=1, le=65535)
    # Home-network addresses of the voice socket; older clients send none.
    local_hosts: list[str] = Field(default_factory=list, max_length=8)


class RoomDiagnosticsDto(ApiModel):
    participant_id: str = Field(min_length=1, max_length=128)
    values: dict[str, str] = Field(max_length=400)


class VoicePeersDto(VoiceJoinDto):
    voice_token: str = Field(pattern=r"^[0-9a-fA-F]{16}$")


class VoicePeer(ApiModel):
    participant_id: str
    host: str
    port: int
    voice_token: str


class VoicePeersResponse(ApiModel):
    peers: list[VoicePeer]


class KaggleEndpointDto(ApiModel):
    url: str = Field(pattern=r"^https://[a-z0-9-]+\.gradio\.live/?$")


@dataclass(frozen=True, slots=True)
class RoomServerContainer:
    """Stands in for the desktop app's ``ApplicationContainer``: room_routes only ever reads ``.rooms`` from it."""

    rooms: RoomCases
    social: SocialCases
    departures: RoomDepartures
    rooms_repository: ObservableRoomRepository


@dataclass(frozen=True, slots=True)
class _RoomHousekeeping:
    """Host failover the desktop app would trigger by polling, and removal of abandoned rooms."""

    cases: RoomCases
    repository: ObservableRoomRepository
    activity: RoomActivity
    projects: RoomProjectFolders

    def sweep_once(self) -> None:
        room_ids = self.repository.list_ids()
        for room_id in room_ids:
            try:
                self.cases.resolve_host_disconnect.execute(room_id)
            except DomainError:
                continue
        for room_id in self.activity.idle(room_ids, _abandoned_room_seconds):
            self.repository.delete(room_id)
        self.projects.remove_orphans(self.repository.list_ids)

    async def run(self) -> None:
        # The sweep reads every stored room, so it runs on a worker thread: on the event loop it
        # stalled every request (and, before the relay had its own thread, every voice packet).
        while True:
            await asyncio.sleep(_sweep_interval_seconds)
            await anyio.to_thread.run_sync(self.sweep_once)


def _room_cleanup(
    cases: RoomCases,
    repository: ObservableRoomRepository,
    social: SocialCases,
    project_root: Path,
    departure_grace_seconds: float,
) -> tuple[RoomProjectFolders, RoomDepartures]:
    """Nothing outlives its room: its uploaded songs go with it, and a closed app leaves it."""
    projects = RoomProjectFolders(project_root)

    def on_room(room_id: str, room: Room | None) -> None:
        if room is None:
            projects.remove(room_id)

    def leave(room_id: str, participant_id: str) -> None:
        cases.leave.execute(room_id, participant_id)

    repository.listen(on_room)
    return projects, RoomDepartures(leave, social.hub.online, departure_grace_seconds)


def _resolve_relay_port(relay_port: int | None) -> int:
    if relay_port is not None:
        return relay_port
    return int(os.getenv("AD_VOICE_ROOM_SERVER_RELAY_PORT", str(_default_relay_port)))


def _lifespan_for(
    container: RoomServerContainer,
    housekeeping: _RoomHousekeeping,
    relay: VoiceRelay,
    relay_port: int,
) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.container = container
        start_social(container.social)
        relay.set_level_listener(
            lambda room_id, levels: container.social.hub.broadcast_room(
                room_id, {"type": "voiceLevels", "roomId": room_id, "levels": levels}
            )
        )
        relay_socket = RelaySocket(relay, relay_port)
        relay_socket.start()
        sweep = asyncio.create_task(housekeeping.run())
        try:
            yield
        finally:
            relay.set_level_listener(None)
            sweep.cancel()
            relay_socket.stop()

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
        token = relay.expect(room_id, body.participant_id, machine_id=body.machine_id)
        return VoiceJoinResponse(voice_token=f"{token:016x}")

    @app.post("/voice/candidate", status_code=204)
    def voice_candidate(body: VoiceCandidateDto) -> Response:
        room_id = normalize_room_id(body.room_id)
        _room_member(repository, room_id, body.participant_id)
        token = int(body.voice_token, 16)
        accepted = relay.register_local_port(
            room_id, body.participant_id, token, body.local_port, tuple(body.local_hosts)
        )
        if not accepted:
            raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token is invalid")
        return Response(status_code=204)

    @app.post("/voice/peers", response_model=VoicePeersResponse)
    def voice_peers(body: VoicePeersDto) -> VoicePeersResponse:
        room_id = normalize_room_id(body.room_id)
        _room_member(repository, room_id, body.participant_id)
        peers = relay.direct_peers(room_id, body.participant_id, int(body.voice_token, 16))
        if not relay.authenticates(room_id, body.participant_id, int(body.voice_token, 16)):
            raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token is invalid")
        return VoicePeersResponse(peers=[VoicePeer.model_validate(peer) for peer in peers])

    @app.post("/voice/metrics")
    def voice_metrics(body: VoicePeersDto) -> dict[str, object]:
        room_id = normalize_room_id(body.room_id)
        _room_member(repository, room_id, body.participant_id)
        token = int(body.voice_token, 16)
        if not relay.authenticates(room_id, body.participant_id, token):
            raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token is invalid")
        return relay.mix_metrics(room_id)

    @app.post("/voice/levels")
    def voice_levels(body: VoicePeersDto) -> dict[str, float]:
        room_id = normalize_room_id(body.room_id)
        _room_member(repository, room_id, body.participant_id)
        token = int(body.voice_token, 16)
        if not relay.authenticates(room_id, body.participant_id, token):
            raise ForbiddenError("RoomVoiceTokenInvalid", "Voice token is invalid")
        return relay.participant_levels(room_id)

    _add_voice_leave_route(app, relay)


def _add_diagnostics_route(
    app: FastAPI, repository: RoomRepository, relay: VoiceRelay, log: RoomDiagnosticsLog
) -> None:
    @app.post("/rooms/{room_id}/diagnostics", status_code=204)
    def room_diagnostics(room_id: str, body: RoomDiagnosticsDto) -> Response:
        """A room member's audio numbers, logged so every computer of a room can be compared."""
        room_id = normalize_room_id(room_id)
        _room_member(repository, room_id, body.participant_id)
        values = {key[:128]: value[:256] for key, value in body.values.items()}
        cadence = relay.recipient_send_metrics(room_id, body.participant_id)
        server_values = {
            "ServerSendPackets": cadence["packets"],
            "ServerSendGapLatestMs": cadence["latest_gap_ms"],
            "ServerSendGapMaximumMs": cadence["maximum_gap_ms"],
            "ServerSendStalls": cadence["stalls"],
            "ServerSendMonotonicMs": cadence["last_send_monotonic_ms"],
        }
        values.update({key: str(value) for key, value in server_values.items()})
        log.append(room_id, body.participant_id, values)
        return Response(status_code=204)


def _add_voice_leave_route(app: FastAPI, relay: VoiceRelay) -> None:
    @app.post("/voice/leave", status_code=204)
    def voice_leave(body: VoiceLeaveDto) -> None:
        relay.forget(body.participant_id)


def _add_kaggle_endpoint_routes(app: FastAPI) -> None:
    endpoints: dict[str, tuple[float, str]] = {}
    lifetime_seconds = 90.0

    @app.put("/kaggle/endpoint", status_code=204)
    def publish_kaggle_endpoint(
        body: KaggleEndpointDto,
        endpoint_key: Annotated[
            str,
            Header(alias="X-AD-Voice-Endpoint-Key", pattern=r"^[a-f0-9]{64}$"),
        ],
    ) -> Response:
        endpoints[endpoint_key] = (time.monotonic(), body.url.rstrip("/"))
        return Response(status_code=204)

    @app.get("/kaggle/endpoint", response_model=KaggleEndpointDto)
    def resolve_kaggle_endpoint(
        endpoint_key: Annotated[
            str,
            Header(alias="X-AD-Voice-Endpoint-Key", pattern=r"^[a-f0-9]{64}$"),
        ],
    ) -> KaggleEndpointDto:
        published = endpoints.get(endpoint_key)
        if published is None or time.monotonic() - published[0] > lifetime_seconds:
            raise NotFoundError("KaggleEndpointNotFound", "Kaggle notebook is not running")
        return KaggleEndpointDto(url=published[1])


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
        room = await anyio.to_thread.run_sync(_room_member, repository, room_id, participant_id)
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


def _add_change_route(app: FastAPI, repository: ObservableRoomRepository) -> None:
    @app.get("/rooms/{room_id}/changes")
    async def room_changes(
        room_id: str,
        participant_id: str = Query(alias="participantId", min_length=1, max_length=128),
        after: int = Query(default=0, ge=0),
    ) -> dict[str, object]:
        room_id = normalize_room_id(room_id)
        await anyio.to_thread.run_sync(_room_member, repository, room_id, participant_id)
        version = await anyio.to_thread.run_sync(lambda: repository.wait_for_change(room_id, after))
        room = await anyio.to_thread.run_sync(repository.get, room_id)
        if room is None:
            return {"version": version, "room": None}
        return {
            "version": version,
            "room": _room(room).model_dump(mode="json", by_alias=True),
        }


def _configure_room_app(
    app: FastAPI, repository: ObservableRoomRepository, activity: RoomActivity
) -> None:
    app.add_middleware(RequestIdentityMiddleware, ids=UuidGenerator())

    @app.middleware("http")
    async def note_room_activity(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        match = _room_path.match(request.url.path)
        if match is not None:
            activity.touch(normalize_room_id(match.group(1)))
        return await call_next(request)

    app.add_exception_handler(DomainError, _domain_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _internal_error)
    app.include_router(room_router)
    _add_change_route(app, repository)

    @app.get("/health/ready")
    def health() -> dict[str, bool]:
        return {"ok": True}


def _configure_relay_room(relay: VoiceRelay, room_id: str, room: Room | None) -> None:
    eligible = (
        None
        if room is None
        else {
            participant.participant_id
            for participant in room.participants.values()
            if participant.connection_state is ConnectionState.CONNECTED
            and participant.voice_timing_ready
        }
    )
    relay.set_room_eligible_participants(room_id, eligible)
    relay.set_room_playout_delay(room_id, None if room is None else room.room_playout_delay_ms)


def create_room_server_app(
    *,
    relay_port: int | None = None,
    room_database: Path | None = None,
    project_root: Path | None = None,
    diagnostics_root: Path | None = None,
    departure_grace_seconds: float = _departure_grace_seconds,
) -> FastAPI:
    """Build the shared room-only server; songs, recordings and AI stay local."""
    repository = ObservableRoomRepository(
        InMemoryRoomRepository() if room_database is None else SqliteRoomRepository(room_database)
    )
    cases = build_room_cases(UuidGenerator(), UtcClock(), repository)
    # Friends and room history live beside the rooms, in a store of their own.
    social = build_room_server_social(
        repository, None if room_database is None else room_database.with_name("social.sqlite3")
    )
    relay = VoiceRelay()
    repository.listen(partial(_configure_relay_room, relay))
    activity = RoomActivity()
    projects, departures = _room_cleanup(
        cases, repository, social, project_root or Path("./room-projects"), departure_grace_seconds
    )
    lifespan = _lifespan_for(
        RoomServerContainer(cases, social, departures, repository),
        _RoomHousekeeping(cases, repository, activity, projects),
        relay,
        _resolve_relay_port(relay_port),
    )
    app = FastAPI(title="A&D Voice Room Server", lifespan=lifespan)
    _configure_room_app(app, repository, activity)

    _add_voice_routes(app, relay, repository)
    _add_project_routes(app, repository, projects.root)
    _add_diagnostics_route(
        app, repository, relay, RoomDiagnosticsLog(diagnostics_root or Path("./room-diagnostics"))
    )
    _add_kaggle_endpoint_routes(app)
    add_social_routes(app)
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
