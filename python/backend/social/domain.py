from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class Presence(StrEnum):
    OFFLINE = "Offline"
    ONLINE = "Online"
    IN_ROOM = "InRoom"


class Relation(StrEnum):
    """What another person is to the one asking."""

    SELF = "Self"
    FRIEND = "Friend"
    REQUESTED = "Requested"  # the asker already sent a friend request
    INCOMING = "Incoming"  # the other person sent the asker a friend request
    NONE = "None"


class InviteState(StrEnum):
    PENDING = "Pending"
    ACCEPTED = "Accepted"
    DECLINED = "Declined"
    EXPIRED = "Expired"


class NoticeKind(StrEnum):
    """Answers the other side gave, told once to the person who asked."""

    FRIEND_ACCEPTED = "FriendAccepted"
    INVITE_ACCEPTED = "InviteAccepted"
    INVITE_DECLINED = "InviteDeclined"
    JOIN_REQUESTED = "JoinRequested"


@dataclass(frozen=True, slots=True)
class Account:
    """A person, recognised by their computer, so friends and history survive a reinstall."""

    account_id: str
    display_name: str
    friend_code: str
    transfer_code: str
    avatar_version: int
    created_at: datetime
    last_seen_at: datetime | None = None
    room_id: str | None = None

    def presence(self, connected: bool) -> Presence:
        """Online is having the app open: its socket to the server is connected."""
        if not connected:
            return Presence.OFFLINE
        return Presence.IN_ROOM if self.room_id else Presence.ONLINE


@dataclass(frozen=True, slots=True)
class FriendRequest:
    from_account_id: str
    to_account_id: str
    created_at: datetime


@dataclass(frozen=True, slots=True)
class RoomInvite:
    invite_id: str
    from_account_id: str
    to_account_id: str
    room_id: str
    state: InviteState
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Notice:
    notice_id: int
    account_id: str
    kind: NoticeKind
    other_account_id: str
    room_id: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Visit:
    """One stay of one participant in one room."""

    room_id: str
    participant_id: str
    account_id: str | None
    display_name: str
    joined_at: datetime
    left_at: datetime | None
