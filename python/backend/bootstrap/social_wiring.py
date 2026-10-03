from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from backend.infrastructure.social_hub import SocialHub
from backend.infrastructure.sqlite_social import SocialDatabase, SqliteAccountStore
from backend.infrastructure.sqlite_social_events import (
    SqliteEventStore,
    SqliteFriendStore,
    SqliteVisitStore,
)
from backend.runtime import Clock, IdGenerator
from backend.social.accounts import Accounts
from backend.social.friends import Friends
from backend.social.history import RoomHistory
from backend.social.inbox import Inbox
from backend.social.invites import RoomExists, RoomInvites

RoomHostParticipant = Callable[[str], str | None]


@dataclass(frozen=True, slots=True)
class SocialCases:
    accounts: Accounts
    friends: Friends
    invites: RoomInvites
    history: RoomHistory
    inbox: Inbox
    hub: SocialHub
    is_room_host: Callable[[str, str], bool]


def build_social_cases(
    database_path: Path | None,
    ids: IdGenerator,
    clock: Clock,
    room_exists: RoomExists,
    room_host_participant: RoomHostParticipant = lambda _room_id: None,
) -> SocialCases:
    database = SocialDatabase(database_path)
    accounts = SqliteAccountStore(database)
    friend_store = SqliteFriendStore(database)
    events = SqliteEventStore(database)
    visits = SqliteVisitStore(database)
    hub = SocialHub()
    account_cases = Accounts(accounts, visits, ids, clock)
    def is_room_host(account_id: str, room_id: str) -> bool:
        participant_id = room_host_participant(room_id)
        if participant_id is None:
            return False
        return account_cases.owners((participant_id,)).get(participant_id) == account_id

    friends = Friends(accounts, friend_store, events, hub, clock)
    invites = RoomInvites(friend_store, events, room_exists, is_room_host, hub, ids, clock)
    return SocialCases(
        accounts=account_cases,
        friends=friends,
        invites=invites,
        history=RoomHistory(visits, clock),
        inbox=Inbox(account_cases, friends, invites, events),
        hub=hub,
        is_room_host=is_room_host,
    )
