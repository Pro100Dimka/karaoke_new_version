"""
Who is asking the room server. A participant id is public (every member of a room sees it), so it
cannot also be the proof of identity. Each app profile keeps a private room key; its participant id
is a hash of that key, and a request may act only as the participant its key hashes to. Knowing the
host's id therefore no longer lets anyone close the room, take the host role, steal the host's voice
slot or "reconnect" in the host's place.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from backend.api.errors import domain_error_response
from backend.domain_errors import ForbiddenError

ROOM_KEY_HEADER = "X-AD-Voice-Room-Key"
_PARTICIPANT_HEADER = "X-Participant-Id"
_PARTICIPANT_FIELD = "participantId"
_PARTICIPANT_SNAKE_FIELD = "participant_id"
_PROJECT_UPLOAD_PATH = re.compile(r"/rooms/[^/]+/projects/[^/]+/[^/]+")
# Stands for a body that names its actor in a form no participant id can match.
_UNREADABLE_BODY = object()
_MINIMUM_KEY_LENGTH = 32
_MAXIMUM_KEY_LENGTH = 256


def participant_id_for(room_key: str) -> str:
    """Must match `roomParticipantIdFor` in the desktop app."""
    return hashlib.sha256(f"ad-voice-room-participant:{room_key}".encode()).hexdigest()[:32]


def _streams_project(request: Request) -> bool:
    """Project uploads stream gigabytes and name their sender only in the header."""
    return request.method == "PUT" and _PROJECT_UPLOAD_PATH.fullmatch(request.url.path) is not None


async def _claimed_participant_ids(request: Request) -> set[object]:
    """Every participant the request could act as, read the way the routes may read it.

    The body is inspected whatever its content type says: FastAPI parses JSON without a content
    type and for every ``+json`` vendor type, and the DTOs accept the snake_case field name too, so
    a narrower reader here would let a request act without naming itself.
    """
    claimed: set[object] = {
        *request.headers.getlist(_PARTICIPANT_HEADER),
        *request.query_params.getlist(_PARTICIPANT_FIELD),
        *request.query_params.getlist(_PARTICIPANT_SNAKE_FIELD),
    }
    if _streams_project(request):
        return claimed
    raw = await request.body()
    if not raw.strip():
        return claimed
    try:
        body = json.loads(raw)
    except ValueError:
        # Not JSON: no route accepts it, but it must never pass as a request that names no one.
        return {*claimed, _UNREADABLE_BODY}
    if isinstance(body, dict):
        for name in (_PARTICIPANT_FIELD, _PARTICIPANT_SNAKE_FIELD):
            if name in body:
                value = body[name]
                claimed.add(value if isinstance(value, str) else _UNREADABLE_BODY)
    return claimed


def _key_owner(request: Request) -> str | None:
    key = request.headers.get(ROOM_KEY_HEADER, "")
    if not _MINIMUM_KEY_LENGTH <= len(key) <= _MAXIMUM_KEY_LENGTH:
        return None
    return participant_id_for(key)


async def authenticate_room_participant(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Rejects a room or voice request that names a participant other than its key's owner."""
    path = request.url.path
    if path.startswith(("/rooms", "/voice/")):
        claimed = await _claimed_participant_ids(request)
        if claimed and claimed != {_key_owner(request)}:
            return domain_error_response(
                request,
                ForbiddenError(
                    "RoomIdentityInvalid", "The request may act only as its own room participant"
                ),
            )
    return await call_next(request)
