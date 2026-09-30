from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

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


@dataclass(frozen=True, slots=True)
class SocialCases:
    accounts: Accounts
    friends: Friends
    invites: RoomInvites
    history: RoomHistory
    inbox: Inbox
    hub: SocialHub


def build_social_cases(
    database_path: Path | None, ids: IdGenerator, clock: Clock, room_exists: RoomExists
) -> SocialCases:
    database = SocialDatabase(database_path)
    accounts = SqliteAccountStore(database)
    friend_store = SqliteFriendStore(database)
    events = SqliteEventStore(database)
    visits = SqliteVisitStore(database)
    hub = SocialHub()
    account_cases = Accounts(accounts, visits, ids, clock)
    friends = Friends(accounts, friend_store, events, hub, clock)
    invites = RoomInvites(friend_store, events, room_exists, hub, ids, clock)
    return SocialCases(
        accounts=account_cases,
        friends=friends,
        invites=invites,
        history=RoomHistory(visits, clock),
        inbox=Inbox(account_cases, friends, invites, events),
        hub=hub,
    )
