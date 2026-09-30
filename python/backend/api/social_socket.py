from __future__ import annotations

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from backend.api.social_dto import HelloDto, PresenceDto
from backend.bootstrap.social_wiring import SocialCases
from backend.social.domain import Account

router = APIRouter()

# Closing codes of RFC 6455: the first message did not say who is connecting.
_POLICY_VIOLATION = 1008


def _arrive(social: SocialCases, hello: HelloDto) -> Account:
    me = social.accounts.identify(hello.device)
    return social.accounts.report_presence(
        me, hello.display_name, hello.participant_id, hello.room_id
    )


def _report(social: SocialCases, me: Account, update: PresenceDto) -> Account:
    """Keeps what the app told; friends are told only when it changes what they see."""
    updated = social.accounts.report_presence(
        me, update.display_name, update.participant_id, update.room_id
    )
    if (updated.display_name, updated.room_id) != (me.display_name, me.room_id):
        social.friends.announce(updated)
    return updated


def _leave(social: SocialCases, me: Account) -> None:
    social.friends.announce(social.accounts.left(me))


@router.websocket("/social/socket")
async def social_socket(websocket: WebSocket) -> None:
    """
    The one connection an open app keeps: it is how the app is online, how it tells its name and
    room when they change, and how it hears requests, invites, answers and friends at once.
    """
    social: SocialCases = websocket.app.state.container.social
    await websocket.accept()
    try:
        hello = HelloDto.model_validate(await websocket.receive_json())
    except (ValidationError, ValueError, WebSocketDisconnect):
        await websocket.close(code=_POLICY_VIOLATION)
        return
    me = await anyio.to_thread.run_sync(_arrive, social, hello)
    first = social.hub.connect(me.account_id, websocket)
    try:
        await social.hub.push(me.account_id)
        if first:
            await anyio.to_thread.run_sync(social.friends.announce, me)
        while True:
            update = PresenceDto.model_validate(await websocket.receive_json())
            me = await anyio.to_thread.run_sync(_report, social, me, update)
    except (WebSocketDisconnect, ValidationError, ValueError):
        pass
    finally:
        if social.hub.disconnect(me.account_id, websocket):
            await anyio.to_thread.run_sync(_leave, social, me)
