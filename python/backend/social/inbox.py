from __future__ import annotations

from dataclasses import dataclass

from backend.social.accounts import Accounts
from backend.social.domain import Account, Notice, RoomInvite
from backend.social.friends import Friends
from backend.social.invites import RoomInvites
from backend.social.ports import EventStore


@dataclass(frozen=True, slots=True)
class InboxView:
    """Everything the open app shows without being asked: pushed whenever it changes."""

    me: Account
    friend_requests: tuple[Account, ...]
    outgoing_requests: tuple[Account, ...]
    invites: tuple[tuple[RoomInvite, Account], ...]
    notices: tuple[tuple[Notice, Account], ...]
    friends: tuple[Account, ...]


class Inbox:
    def __init__(
        self, accounts: Accounts, friends: Friends, invites: RoomInvites, events: EventStore
    ) -> None:
        self._accounts = accounts
        self._friends = friends
        self._invites = invites
        self._events = events

    def view(self, account_id: str) -> InboxView:
        """The account's inbox; answers not yet told are handed out with it, once."""
        me = self._accounts.person(account_id)
        invites = self._invites.pending(me)
        notices = self._events.take_notices(account_id)
        others = self._accounts.people(
            tuple(invite.from_account_id for invite in invites)
            + tuple(notice.other_account_id for notice in notices)
        )
        by_id = {account.account_id: account for account in others}
        return InboxView(
            me=me,
            friend_requests=self._friends.incoming(me),
            outgoing_requests=self._friends.outgoing(me),
            invites=tuple(
                (invite, by_id[invite.from_account_id])
                for invite in invites
                if invite.from_account_id in by_id
            ),
            notices=tuple(
                (notice, by_id[notice.other_account_id])
                for notice in notices
                if notice.other_account_id in by_id
            ),
            friends=self._friends.friends(me),
        )
