from __future__ import annotations

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from backend.api.social_dto import HelloDto, PresenceDto
from backend.bootstrap.social_wiring import SocialCases
from backend.infrastructure.room_departures import RoomDepartures
from backend.social.domain import Account
from backend.domain_errors import DomainError
from backend.social.codes import device_participant_id

router = APIRouter()

# Closing codes of RFC 6455: the first message did not say who is connecting.
_POLICY_VIOLATION = 1008


def _arrive(social: SocialCases, hello: HelloDto) -> Account:
    me = social.accounts.identify(hello.device)
    return social.accounts.report_presence(
        me, hello.display_name, hello.participant_id, hello.room_id, hello.device
    )


def _report(social: SocialCases, me: Account, update: PresenceDto, device: str) -> Account:
    """Keeps what the app told; friends are told only when it changes what they see."""
    updated = social.accounts.report_presence(
        me, update.display_name, update.participant_id, update.room_id, device
    )
    if (updated.display_name, updated.room_id) != (me.display_name, me.room_id):
        social.friends.announce(updated)
    return updated


def _leave(social: SocialCases, me: Account, device: str) -> bool:
    updated = social.accounts.left(me, device)
    if updated is None:
        return False
    social.friends.announce(updated)
    return True


def _connect(social: SocialCases, me: Account, device: str, socket: WebSocket) -> bool:
    def bind() -> bool:
        first = social.hub.connect(me.account_id, socket)
        social.hub.set_room(me.account_id, me.room_id)
        return first

    return social.accounts.bind_session(me, device, bind)


@router.websocket("/social/socket")
async def social_socket(websocket: WebSocket) -> None:
    """The app's authenticated presence and social updates."""
    social: SocialCases = websocket.app.state.container.social
    await websocket.accept()
    try:
        hello = HelloDto.model_validate(await websocket.receive_json())
        websocket.app.state.transfer_consent.require(device_participant_id(hello.device), "online")
        me = await anyio.to_thread.run_sync(_arrive, social, hello)
        first = await anyio.to_thread.run_sync(_connect, social, me, hello.device, websocket)
    except (ValidationError, ValueError, WebSocketDisconnect, DomainError):
        await websocket.close(code=_POLICY_VIOLATION)
        return
    presence: PresenceDto = hello
    try:
        await social.hub.send(websocket, {"type": "presenceAck", "revision": hello.revision})
        await social.hub.push(me.account_id)
        if first:
            await anyio.to_thread.run_sync(social.friends.announce, me)
        while True:
            update = PresenceDto.model_validate(await websocket.receive_json())
            websocket.app.state.transfer_consent.require(
                device_participant_id(hello.device), "online"
            )
            me = await anyio.to_thread.run_sync(_report, social, me, update, hello.device)
            presence = update
            social.hub.set_room(me.account_id, me.room_id)
            await social.hub.send(websocket, {"type": "presenceAck", "revision": presence.revision})
    except DomainError:
        await websocket.close(code=_POLICY_VIOLATION)
    except (WebSocketDisconnect, ValidationError, ValueError):
        pass
    finally:
        # The handler may be ending by cancellation (the server cancels a closed connection's task);
        # shielding keeps a closed app from staying in its room because its cleanup was cut short.
        with anyio.CancelScope(shield=True):
            if social.hub.disconnect(me.account_id, websocket) and await anyio.to_thread.run_sync(
                _leave, social, me, hello.device
            ):
                if presence.room_id and presence.participant_id:
                    departures: RoomDepartures = websocket.app.state.container.departures
                    departures.gone(me.account_id, presence.participant_id, presence.room_id)
