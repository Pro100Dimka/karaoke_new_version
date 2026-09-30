from __future__ import annotations

from backend.domain_errors import DomainError, NotFoundError
from backend.runtime import Clock
from backend.social.codes import normalize_code
from backend.social.domain import Account, FriendRequest, NoticeKind, Relation
from backend.social.ports import AccountStore, ChangeNotifier, EventStore, FriendStore


class Friends:
    """Friendship is mutual: a request becomes a friendship only when the other person accepts."""

    def __init__(
        self,
        accounts: AccountStore,
        friends: FriendStore,
        events: EventStore,
        notifier: ChangeNotifier,
        clock: Clock,
    ) -> None:
        self._accounts = accounts
        self._friends = friends
        self._events = events
        self._notifier = notifier
        self._clock = clock

    def request_by_code(self, me: Account, friend_code: str) -> tuple[Account, Relation]:
        target = self._accounts.by_friend_code(normalize_code(friend_code))
        if target is None:
            raise NotFoundError("FriendCodeNotFound", "No one has this friend code")
        return target, self.request(me, target.account_id)

    def request(self, me: Account, target_id: str) -> Relation:
        """Sends a friend request; one the other person already sent is simply accepted."""
        if target_id == me.account_id:
            raise DomainError("FriendIsSelf", "You cannot add yourself as a friend")
        if self._accounts.by_id(target_id) is None:
            raise NotFoundError("AccountNotFound", "This person was not found", accountId=target_id)
        if self._friends.are_friends(me.account_id, target_id):
            return Relation.FRIEND
        if self._friends.request(target_id, me.account_id) is not None:
            self.accept(me, target_id)
            return Relation.FRIEND
        if self._friends.request(me.account_id, target_id) is None:
            now = self._clock.now()
            self._friends.add_request(FriendRequest(me.account_id, target_id, now))
            self._notifier.changed((me.account_id, target_id))
        return Relation.REQUESTED

    def accept(self, me: Account, requester_id: str) -> None:
        if self._friends.request(requester_id, me.account_id) is None:
            raise NotFoundError("FriendRequestNotFound", "This friend request no longer exists")
        now = self._clock.now()
        self._friends.remove_request(requester_id, me.account_id)
        self._friends.remove_request(me.account_id, requester_id)
        self._friends.befriend(me.account_id, requester_id, now)
        self._events.add_notice(requester_id, NoticeKind.FRIEND_ACCEPTED, me.account_id, None, now)
        self._notifier.changed((me.account_id, requester_id))

    def decline(self, me: Account, requester_id: str) -> None:
        self._friends.remove_request(requester_id, me.account_id)
        self._notifier.changed((me.account_id, requester_id))

    def cancel(self, me: Account, target_id: str) -> None:
        self._friends.remove_request(me.account_id, target_id)
        self._notifier.changed((me.account_id, target_id))

    def remove(self, me: Account, friend_id: str) -> None:
        self._friends.unfriend(me.account_id, friend_id)
        self._notifier.changed((me.account_id, friend_id))

    def announce(self, me: Account) -> None:
        """Friends see this person anew: came online, left, entered a room, changed the photo."""
        self._notifier.changed(self._friends.friend_ids(me.account_id))

    def friends(self, me: Account) -> tuple[Account, ...]:
        return self._accounts.by_ids(self._friends.friend_ids(me.account_id))

    def incoming(self, me: Account) -> tuple[Account, ...]:
        requests = self._friends.requests_to(me.account_id)
        return self._accounts.by_ids(tuple(request.from_account_id for request in requests))

    def outgoing(self, me: Account) -> tuple[Account, ...]:
        requests = self._friends.requests_from(me.account_id)
        return self._accounts.by_ids(tuple(request.to_account_id for request in requests))

    def relations(self, me: Account, account_ids: tuple[str, ...]) -> dict[str, Relation]:
        friends = set(self._friends.friend_ids(me.account_id))
        sent = {request.to_account_id for request in self._friends.requests_from(me.account_id)}
        received = {request.from_account_id for request in self._friends.requests_to(me.account_id)}

        def relation(account_id: str) -> Relation:
            if account_id == me.account_id:
                return Relation.SELF
            if account_id in friends:
                return Relation.FRIEND
            if account_id in sent:
                return Relation.REQUESTED
            return Relation.INCOMING if account_id in received else Relation.NONE

        return {account_id: relation(account_id) for account_id in account_ids}
