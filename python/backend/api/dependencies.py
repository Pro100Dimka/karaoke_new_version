from __future__ import annotations

from typing import cast

from fastapi import Request

from backend.bootstrap.container import ApplicationContainer


def container(request: Request) -> ApplicationContainer:
    return cast(ApplicationContainer, request.app.state.container)
