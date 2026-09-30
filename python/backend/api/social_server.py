from __future__ import annotations

from pathlib import Path
from typing import Callable

from fastapi import FastAPI

from backend.api.social_dto import inbox_dto
from backend.api.social_routes import router as social_router
from backend.api.social_socket import router as social_socket_router
from backend.bootstrap.social_wiring import SocialCases, build_social_cases
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from backend.room.domain import ConnectionState, Room


def _follow_rooms(social: SocialCases) -> Callable[[str, Room | None], None]:
    """Room history and invitations follow the rooms: who is connected, and rooms that close."""

    def on_room(room_id: str, room: Room | None) -> None:
        connected = (
            {}
            if room is None
            else {
                participant.participant_id: participant.display_name
                for participant in room.participants.values()
                if participant.connection_state is ConnectionState.CONNECTED
            }
        )
        social.history.record(room_id, connected)
        if room is None:
            social.invites.room_closed(room_id)

    return on_room


def build_room_server_social(
    repository: ObservableRoomRepository, database_path: Path | None
) -> SocialCases:
    social = build_social_cases(
        database_path,
        UuidGenerator(),
        UtcClock(),
        lambda room_id: repository.get(room_id) is not None,
    )
    repository.listen(_follow_rooms(social))
    return social


def start_social(social: SocialCases) -> None:
    """Starts pushing inboxes; runs inside the server's event loop."""
    social.hub.start(
        lambda account_id: inbox_dto(social, social.inbox.view(account_id)).model_dump(
            by_alias=True, mode="json"
        )
    )


def add_social_routes(app: FastAPI) -> None:
    app.include_router(social_router)
    app.include_router(social_socket_router)
