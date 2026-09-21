from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from backend.domain_errors import DomainError


def domain_error_response(request: Request, error: DomainError) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None)
    correlation_id = request.headers.get("X-Correlation-ID")
    body: dict[str, object] = {
        "code": error.code,
        "message": error.message,
        "details": dict(error.details),
    }
    if request_id:
        body["requestId"] = request_id
    if correlation_id:
        body["correlationId"] = correlation_id
    return JSONResponse(status_code=error.status_code, content=body)
