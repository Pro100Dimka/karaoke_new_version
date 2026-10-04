from __future__ import annotations

from datetime import datetime

from pydantic import Field

from backend.api.base_dto import ApiModel
from backend.bootstrap.social_wiring import SocialCases
from backend.social.accounts import MAXIMUM_AVATAR_BYTES
from backend.social.domain import Account, Presence, Relation
from backend.social.history import RoomStay
from backend.social.inbox import InboxView


class MeDto(ApiModel):
    account_id: str
    display_name: str
    friend_code: str
    transfer_code: str
    avatar_version: int


class PersonDto(ApiModel):
    account_id: str
    display_name: str
    avatar_version: int
    presence: Presence
    room_id: str | None
    last_seen_at: datetime | None
    relation: Relation
    is_room_host: bool


class PresenceDto(ApiModel):
    """What the app tells about itself whenever it changes: its name and the room it is in."""

    display_name: str = Field(max_length=200)
    participant_id: str | None = Field(default=None, max_length=128)
    room_id: str | None = Field(default=None, max_length=128)
    revision: int = Field(default=0, ge=0)


class HelloDto(PresenceDto):
    """The first message on a socket: who is connecting."""

    device: str = Field(min_length=32, max_length=256)


class InviteDto(ApiModel):
    invite_id: str
    room_id: str
    sender: PersonDto
    created_at: datetime


class NoticeDto(ApiModel):
    kind: str
    person: PersonDto
    room_id: str | None


class InboxDto(ApiModel):
    """Pushed over the socket whenever anything in it changes."""

    type: str = "inbox"
    me: MeDto
    friends: list[PersonDto]
    friend_requests: list[PersonDto]
    outgoing_requests: list[PersonDto]
    invites: list[InviteDto]
    notices: list[NoticeDto]


class FriendRequestDto(ApiModel):
    friend_code: str | None = Field(default=None, max_length=32)
    account_id: str | None = Field(default=None, max_length=128)


class RelationDto(ApiModel):
    relation: Relation
    person: PersonDto


class RoomInviteDto(ApiModel):
    account_id: str = Field(min_length=1, max_length=128)
    room_id: str = Field(min_length=1, max_length=128)


class JoinDto(ApiModel):
    room_id: str


class PeopleRequestDto(ApiModel):
    participant_ids: list[str] = Field(max_length=64)


class ParticipantPersonDto(ApiModel):
    participant_id: str
    person: PersonDto


class StayPersonDto(ApiModel):
    participant_id: str
    display_name: str
    person: PersonDto | None


class StayDto(ApiModel):
    room_id: str
    joined_at: datetime
    left_at: datetime | None
    seconds: float
    people: list[StayPersonDto]


class AvatarDto(ApiModel):
    mime: str = Field(pattern=r"^image/(png|jpeg|webp)$")
    # Base64 of at most MAXIMUM_AVATAR_BYTES bytes.
    data: str = Field(min_length=1, max_length=(MAXIMUM_AVATAR_BYTES + 2) // 3 * 4)
    version: int = 0


class TransferDto(ApiModel):
    transfer_code: str = Field(min_length=1, max_length=64)


def me_dto(account: Account) -> MeDto:
    return MeDto(
        account_id=account.account_id,
        display_name=account.display_name,
        friend_code=account.friend_code,
        transfer_code=account.transfer_code,
        avatar_version=account.avatar_version,
    )


def people_dto(
    social: SocialCases, me: Account, accounts: tuple[Account, ...]
) -> dict[str, PersonDto]:
    relations = social.friends.relations(me, tuple(item.account_id for item in accounts))
    return {
        account.account_id: PersonDto(
            account_id=account.account_id,
            display_name=account.display_name,
            avatar_version=account.avatar_version,
            presence=account.presence(social.hub.online(account.account_id)),
            room_id=account.room_id,
            last_seen_at=account.last_seen_at,
            relation=relations[account.account_id],
            is_room_host=bool(
                account.room_id and social.is_room_host(account.account_id, account.room_id)
            ),
        )
        for account in accounts
    }


def person_list(social: SocialCases, me: Account, accounts: tuple[Account, ...]) -> list[PersonDto]:
    return list(people_dto(social, me, accounts).values())


def inbox_dto(social: SocialCases, view: InboxView) -> InboxDto:
    me = view.me
    senders = people_dto(social, me, tuple(sender for _, sender in view.invites))
    others = people_dto(social, me, tuple(other for _, other in view.notices))
    return InboxDto(
        me=me_dto(me),
        friends=person_list(social, me, view.friends),
        friend_requests=person_list(social, me, view.friend_requests),
        outgoing_requests=person_list(social, me, view.outgoing_requests),
        invites=[
            InviteDto(
                invite_id=invite.invite_id,
                room_id=invite.room_id,
                sender=senders[sender.account_id],
                created_at=invite.created_at,
            )
            for invite, sender in view.invites
        ],
        notices=[
            NoticeDto(
                kind=notice.kind.value, person=others[other.account_id], room_id=notice.room_id
            )
            for notice, other in view.notices
        ],
    )


def stay_dto(stay: RoomStay, persons: dict[str, PersonDto]) -> StayDto:
    return StayDto(
        room_id=stay.room_id,
        joined_at=stay.joined_at,
        left_at=stay.left_at,
        seconds=stay.seconds,
        people=[
            StayPersonDto(
                participant_id=person.participant_id,
                display_name=person.display_name,
                person=persons.get(person.account_id or ""),
            )
            for person in stay.people
        ],
    )
