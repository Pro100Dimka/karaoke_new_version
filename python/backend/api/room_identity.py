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
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from backend.api.errors import domain_error_response
from backend.domain_errors import ForbiddenError

ROOM_KEY_HEADER = "X-AD-Voice-Room-Key"
_PARTICIPANT_HEADER = "X-Participant-Id"
_PARTICIPANT_FIELD = "participantId"
_MINIMUM_KEY_LENGTH = 32
_MAXIMUM_KEY_LENGTH = 256


def participant_id_for(room_key: str) -> str:
    """Must match `roomParticipantIdFor` in the desktop app."""
    return hashlib.sha256(f"ad-voice-room-participant:{room_key}".encode()).hexdigest()[:32]


async def _claimed_participant_ids(request: Request) -> set[str]:
    claimed = {request.headers.get(_PARTICIPANT_HEADER), request.query_params.get(_PARTICIPANT_FIELD)}
    # Project uploads stream hundreds of megabytes; only JSON bodies are read here.
    if request.headers.get("content-type", "").startswith("application/json"):
        try:
            body = json.loads(await request.body() or b"null")
        except ValueError:
            body = None
        if isinstance(body, dict):
            value = body.get(_PARTICIPANT_FIELD)
            claimed.add(value if isinstance(value, str) else None)
    return {value for value in claimed if value is not None}


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
