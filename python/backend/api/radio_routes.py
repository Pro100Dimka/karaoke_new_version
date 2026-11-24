from functools import partial
from threading import Event
from typing import Annotated

import anyio
from fastapi import APIRouter, Query, Request, Response

from backend.infrastructure.youtube_radio import YoutubeRadio
from backend.domain_errors import DomainError

router = APIRouter()
radio_limit = anyio.CapacityLimiter(2)


@router.get("/radio/youtube", response_model=dict[str, str | int])
async def youtube_radio(
    request: Request,
    playlist_id: Annotated[str, Query(pattern=r"^[A-Za-z0-9_-]{10,100}$")],
    index: Annotated[int, Query(ge=1, le=100_000)] = 1,
) -> dict[str, str | int] | Response:
    # Waiting for a slow remote playlist must not consume the workers used by controls.
    if await request.is_disconnected():
        return Response(status_code=499)
    cancel = Event()
    result: dict[str, str | int] | DomainError | None = None
    async with anyio.create_task_group() as tasks:

        async def disconnected() -> None:
            try:
                while True:
                    if (await request.receive())["type"] == "http.disconnect":
                        tasks.cancel_scope.cancel()
                        return
            finally:
                cancel.set()

        tasks.start_soon(disconnected)
        try:
            async with radio_limit:
                result = await anyio.to_thread.run_sync(
                    partial(YoutubeRadio().resolve, playlist_id, index, cancel=cancel)
                )
        except DomainError as error:
            result = error
        finally:
            cancel.set()
            tasks.cancel_scope.cancel()
    if isinstance(result, DomainError):
        if result.code != "ProcessCancelled":
            raise result
        result = None
    return result if result is not None else Response(status_code=499)
