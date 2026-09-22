from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from collections.abc import Sequence
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from backend.ai.ports import AiProvider
from backend.api.errors import domain_error_response
from backend.api.middleware import RequestIdentityMiddleware
from backend.api.model_routes import router as model_router
from backend.api.package_routes import router as package_router
from backend.api.recording_routes import router as recording_router
from backend.api.room_routes import router as room_router
from backend.api.settings_routes import router as settings_router
from backend.api.song_editor_routes import router as song_editor_router
from backend.api.song_processing_routes import router as song_processing_router
from backend.api.song_routes import router as song_router
from backend.api.system_routes import router as system_router
from backend.bootstrap.build import build_container
from backend.bootstrap.config import BackendConfig
from backend.domain_errors import DomainError
from backend.infrastructure.ids import UuidGenerator
from backend.lyrics.ports import OnlineLyricsProvider
from backend.songs.recognition import SongRecognitionProvider
from backend.version import BACKEND_VERSION

logger = logging.getLogger(__name__)
_ROUTERS = (
    system_router,
    song_router,
    song_processing_router,
    song_editor_router,
    package_router,
    recording_router,
    model_router,
    settings_router,
    room_router,
)


def create_app(
    config: BackendConfig | None = None,
    *,
    ai_providers: Sequence[AiProvider] = (),
    lyrics_providers: Sequence[OnlineLyricsProvider] = (),
    recognition_provider: SongRecognitionProvider | None = None,
) -> FastAPI:
    resolved = config or BackendConfig.load()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        container = build_container(
            resolved,
            ai_providers=ai_providers,
            lyrics_providers=lyrics_providers,
            recognition_provider=recognition_provider,
        )
        app.state.container = container
        try:
            yield
        finally:
            container.shutdown()

    app = FastAPI(title="A&D Voice Backend", version=BACKEND_VERSION, lifespan=lifespan)
    app.add_middleware(RequestIdentityMiddleware, ids=UuidGenerator())
    app.add_exception_handler(DomainError, _domain_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_exception_handler(Exception, _internal_error)
    for router in _ROUTERS:
        app.include_router(router)
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
    logger.exception("Unhandled API error", exc_info=error)
    return JSONResponse(
        status_code=500,
        content={
            "code": "InternalError",
            "message": "Internal backend error",
            "details": {},
            "requestId": getattr(request.state, "request_id", None),
        },
    )
