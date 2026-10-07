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
from fastapi.responses import JSONResponse
from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.api.errors import domain_error_response
from backend.api.middleware import RequestIdentityMiddleware
from backend.api.room_diagnostics_routes import add_diagnostics_route
from backend.api.room_identity import authenticate_room_participant
from backend.api.room_project_routes import add_project_routes
from backend.api.room_routes import _room, router as room_router
from backend.api.room_server_access import room_member
from backend.api.room_voice_routes import add_voice_routes
from backend.api.social_server import add_social_routes, build_room_server_social, start_social
from backend.bootstrap.room_wiring import RoomCases, build_room_cases
from backend.bootstrap.social_wiring import SocialCases
from backend.domain_errors import DomainError, NotFoundError
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.sqlite_rooms import SqliteRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.infrastructure.room_activity import RoomActivity
from backend.infrastructure.room_departures import RoomDepartures
from backend.infrastructure.room_project_folders import RoomProjectFolders
from backend.infrastructure.room_diagnostics import RoomDiagnosticsLog
from backend.room.domain import ConnectionState, Room
from backend.infrastructure.voice_relay import RelaySocket, VoiceRelay
from backend.infrastructure.native_voice_relay import NativeVoiceRelayProcess
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
    native_relay: NativeVoiceRelayProcess | None = None,
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
        relay_socket = None if native_relay is not None else RelaySocket(relay, relay_port)
        if native_relay is not None:
            native_relay.start()
        else:
            assert relay_socket is not None
            relay_socket.start()
        sweep = asyncio.create_task(housekeeping.run())
        try:
            yield
        finally:
            relay.set_level_listener(None)
            sweep.cancel()
            if native_relay is not None:
                native_relay.stop()
            else:
                assert relay_socket is not None
                relay_socket.stop()

    return lifespan


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


def _add_change_route(app: FastAPI, repository: ObservableRoomRepository) -> None:
    @app.get("/rooms/{room_id}/changes")
    async def room_changes(
        room_id: str,
        participant_id: str = Query(alias="participantId", min_length=1, max_length=128),
        after: int = Query(default=0, ge=0),
    ) -> dict[str, object]:
        room_id = normalize_room_id(room_id)
        await anyio.to_thread.run_sync(room_member, repository, room_id, participant_id)
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
    app.middleware("http")(authenticate_room_participant)

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
            and (room.song_id is None or participant.voice_eligible)
        }
    )
    relay.set_room_eligible_participants(room_id, eligible)
    if room is None:
        relay.set_room_playout_delay(room_id, None)
    else:
        relay.set_room_playout_delay(
            room_id, room.room_playout_delay_ms, return_reserve_ms=room.room_return_reserve_ms
        )


def _voice_relays(
    native_relay_executable: Path | None, relay_port: int
) -> tuple[NativeVoiceRelayProcess | None, VoiceRelay]:
    """The relay control plane, and the native data plane it drives when one is configured."""
    configured_native = os.getenv("AD_VOICE_NATIVE_RELAY_EXECUTABLE", "").strip()
    native_path = native_relay_executable or (Path(configured_native) if configured_native else None)
    if native_path is None:
        return None, VoiceRelay()
    native_relay = NativeVoiceRelayProcess(native_path, relay_port)
    return native_relay, VoiceRelay(
        control_command=native_relay.command,
        recipient_metrics=native_relay.recipient_metrics,
        participant_levels=native_relay.participant_levels,
    )


def create_room_server_app(
    *,
    relay_port: int | None = None,
    room_database: Path | None = None,
    project_root: Path | None = None,
    diagnostics_root: Path | None = None,
    departure_grace_seconds: float = _departure_grace_seconds,
    native_relay_executable: Path | None = None,
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
    selected_relay_port = _resolve_relay_port(relay_port)
    native_relay, relay = _voice_relays(native_relay_executable, selected_relay_port)
    repository.listen(partial(_configure_relay_room, relay))
    activity = RoomActivity()
    projects, departures = _room_cleanup(
        cases, repository, social, project_root or Path("./room-projects"), departure_grace_seconds
    )
    lifespan = _lifespan_for(
        RoomServerContainer(cases, social, departures, repository),
        _RoomHousekeeping(cases, repository, activity, projects),
        relay,
        selected_relay_port,
        native_relay,
    )
    app = FastAPI(title="A&D Voice Room Server", lifespan=lifespan)
    _configure_room_app(app, repository, activity)
    _add_service_routes(app, relay, repository, projects.root, diagnostics_root)
    return app


def _add_service_routes(
    app: FastAPI,
    relay: VoiceRelay,
    repository: ObservableRoomRepository,
    project_root: Path,
    diagnostics_root: Path | None,
) -> None:
    add_voice_routes(app, relay, repository)
    add_project_routes(app, repository, project_root)
    add_diagnostics_route(
        app, repository, relay, RoomDiagnosticsLog(diagnostics_root or Path("./room-diagnostics"))
    )
    _add_kaggle_endpoint_routes(app)
    add_social_routes(app)


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
