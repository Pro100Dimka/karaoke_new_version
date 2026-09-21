from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backend.runtime import IdGenerator
from backend.version import API_VERSION


class RequestIdentityMiddleware:
    def __init__(self, app: ASGIApp, ids: IdGenerator) -> None:
        self._app = app
        self._ids = ids

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        request_id = request.headers.get("X-Request-ID") or self._ids.new()
        scope.setdefault("state", {})["request_id"] = request_id
        requested = request.headers.get("X-API-Version")
        if requested and requested != str(API_VERSION):
            response = JSONResponse(
                status_code=409,
                content={
                    "code": "ApiVersionMismatch",
                    "message": "API version is incompatible",
                    "details": {"expected": API_VERSION, "received": requested},
                    "requestId": request_id,
                },
            )
            await response(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode("ascii", errors="ignore")))
                headers.append((b"x-api-version", str(API_VERSION).encode("ascii")))
                message["headers"] = headers
            await send(message)

        await self._app(scope, receive, send_with_headers)
