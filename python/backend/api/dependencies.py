from __future__ import annotations

from starlette.requests import HTTPConnection


def container(request: HTTPConnection) -> object:
    return request.app.state.container
