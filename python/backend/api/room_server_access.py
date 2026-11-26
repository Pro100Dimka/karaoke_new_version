from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
import anyio
from fastapi.responses import FileResponse
from starlette.types import Message, Receive, Scope, Send

from backend.domain_errors import ForbiddenError, NotFoundError
from backend.room.domain import Room
from backend.room.ports import RoomRepository


class ConsentedFileResponse(FileResponse):
    """Keep range support while stopping an archive response after consent withdrawal."""

    def __init__(
        self, path: Path, allowed: Callable[[], object], *, filename: str | None = None
    ) -> None:
        super().__init__(path, media_type="application/zip", filename=filename)
        self._allowed = allowed

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def checked_send(message: Message) -> None:
            if message["type"] in ["http.response.start", "http.response.body"]:
                await anyio.to_thread.run_sync(self._allowed)
            await send(message)

        checked_scope: Scope = dict(scope)
        checked_scope["extensions"] = {
            key: value
            for key, value in scope.get("extensions", {}).items()
            if key != "http.response.pathsend"
        }
        await super().__call__(checked_scope, receive, checked_send)


def room_member(repository: RoomRepository, room_id: str, participant_id: str) -> Room:
    """The room, when the participant belongs to it."""
    room = repository.get(room_id)
    if room is None:
        raise NotFoundError("RoomNotFound", "Room was not found", roomId=room_id)
    if participant_id not in room.participants:
        raise ForbiddenError("RoomPermissionDenied", "Participant is not in this room")
    return room
