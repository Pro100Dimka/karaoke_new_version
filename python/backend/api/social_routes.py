from __future__ import annotations

import base64
import binascii
from typing import Annotated, Protocol

from fastapi import APIRouter, Depends, Header

from backend.api.dependencies import container
from backend.api.social_dto import (
    AvatarDto,
    FriendRequestDto,
    JoinDto,
    MeDto,
    ParticipantPersonDto,
    PeopleRequestDto,
    RelationDto,
    RoomInviteDto,
    StayDto,
    TransferDto,
    me_dto,
    people_dto,
    stay_dto,
)
from backend.bootstrap.social_wiring import SocialCases
from backend.domain_errors import DomainError

# One-off actions the user takes; everything the app shows unasked arrives over the socket.
router = APIRouter(prefix="/social")

_HISTORY_ROOMS = 50


class SocialContainer(Protocol):
    social: SocialCases


ContainerDep = Annotated[SocialContainer, Depends(container)]
# A secret only this computer (and app profile) knows; the server keeps just its hash.
DeviceDep = Annotated[str, Header(alias="X-AD-Voice-Device", min_length=32, max_length=256)]


@router.get("/me", response_model=MeDto)
def me(app: ContainerDep, device: DeviceDep) -> MeDto:
    return me_dto(app.social.accounts.identify(device))


@router.post("/friends/requests", response_model=RelationDto)
def request_friend(body: FriendRequestDto, app: ContainerDep, device: DeviceDep) -> RelationDto:
    social = app.social
    me = social.accounts.identify(device)
    if body.friend_code:
        target, _ = social.friends.request_by_code(me, body.friend_code)
    elif body.account_id:
        social.friends.request(me, body.account_id)
        target = social.accounts.person(body.account_id)
    else:
        raise DomainError("FriendNotGiven", "Give a friend code or a person")
    person = people_dto(social, me, (target,))[target.account_id]
    return RelationDto(relation=person.relation, person=person)


@router.post("/friends/requests/{account_id}/accept", status_code=204)
def accept_friend(account_id: str, app: ContainerDep, device: DeviceDep) -> None:
    app.social.friends.accept(app.social.accounts.identify(device), account_id)


@router.post("/friends/requests/{account_id}/decline", status_code=204)
def decline_friend(account_id: str, app: ContainerDep, device: DeviceDep) -> None:
    app.social.friends.decline(app.social.accounts.identify(device), account_id)


@router.delete("/friends/requests/{account_id}", status_code=204)
def cancel_friend_request(account_id: str, app: ContainerDep, device: DeviceDep) -> None:
    app.social.friends.cancel(app.social.accounts.identify(device), account_id)


@router.delete("/friends/{account_id}", status_code=204)
def remove_friend(account_id: str, app: ContainerDep, device: DeviceDep) -> None:
    app.social.friends.remove(app.social.accounts.identify(device), account_id)


@router.post("/invites", status_code=204)
def invite(body: RoomInviteDto, app: ContainerDep, device: DeviceDep) -> None:
    me = app.social.accounts.identify(device)
    app.social.invites.invite(me, body.account_id, body.room_id)


@router.post("/invites/{invite_id}/accept", response_model=JoinDto)
def accept_invite(invite_id: str, app: ContainerDep, device: DeviceDep) -> JoinDto:
    me = app.social.accounts.identify(device)
    return JoinDto(room_id=app.social.invites.accept(me, invite_id))


@router.post("/invites/{invite_id}/decline", status_code=204)
def decline_invite(invite_id: str, app: ContainerDep, device: DeviceDep) -> None:
    app.social.invites.decline(app.social.accounts.identify(device), invite_id)


@router.post("/people", response_model=list[ParticipantPersonDto])
def people(
    body: PeopleRequestDto, app: ContainerDep, device: DeviceDep
) -> list[ParticipantPersonDto]:
    """Who a room's participants are: their photos and what they are to the asker."""
    social = app.social
    me = social.accounts.identify(device)
    owners = social.accounts.owners(tuple(body.participant_ids))
    persons = people_dto(social, me, social.accounts.people(tuple(owners.values())))
    return [
        ParticipantPersonDto(participant_id=participant, person=persons[account])
        for participant, account in owners.items()
        if account in persons
    ]


@router.get("/history", response_model=list[StayDto])
def history(app: ContainerDep, device: DeviceDep) -> list[StayDto]:
    social = app.social
    me = social.accounts.identify(device)
    stays = social.history.recent(me, _HISTORY_ROOMS)
    known = tuple({p.account_id for s in stays for p in s.people if p.account_id is not None})
    persons = people_dto(social, me, social.accounts.people(known))
    return [stay_dto(stay, persons) for stay in stays]


@router.put("/avatar", response_model=MeDto)
def set_avatar(body: AvatarDto, app: ContainerDep, device: DeviceDep) -> MeDto:
    try:
        data = base64.b64decode(body.data, validate=True)
    except binascii.Error as error:
        raise DomainError("UnsupportedAvatar", "Photo data is not valid") from error
    social = app.social
    me = social.accounts.set_avatar(social.accounts.identify(device), body.mime, data)
    social.friends.announce(me)
    social.hub.changed((me.account_id,))
    return me_dto(me)


@router.delete("/avatar", response_model=MeDto)
def clear_avatar(app: ContainerDep, device: DeviceDep) -> MeDto:
    social = app.social
    me = social.accounts.clear_avatar(social.accounts.identify(device))
    social.friends.announce(me)
    social.hub.changed((me.account_id,))
    return me_dto(me)


@router.get("/avatars/{account_id}", response_model=AvatarDto)
def avatar(account_id: str, app: ContainerDep, device: DeviceDep) -> AvatarDto:
    app.social.accounts.identify(device)
    mime, data, version = app.social.accounts.avatar(account_id)
    return AvatarDto(mime=mime, data=base64.b64encode(data).decode(), version=version)


@router.post("/transfer", response_model=MeDto)
def transfer(body: TransferDto, app: ContainerDep, device: DeviceDep) -> MeDto:
    """This computer takes over the account of another one (moving to a new computer)."""
    me = app.social.accounts.identify(device)
    return me_dto(app.social.accounts.claim(me, body.transfer_code, device))
