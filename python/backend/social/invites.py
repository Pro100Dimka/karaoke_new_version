from __future__ import annotations

from dataclasses import replace
from typing import Callable

from backend.domain_errors import ConflictError, ForbiddenError, NotFoundError
from backend.runtime import Clock, IdGenerator
from backend.social.domain import Account, InviteState, NoticeKind, RoomInvite
from backend.social.ports import ChangeNotifier, EventStore, FriendStore

RoomExists = Callable[[str], bool]
RoomHost = Callable[[str, str], bool]


class RoomInvites:
    """A friend is asked into the room; they accept (and join) or decline (and the asker is told)."""

    def __init__(
        self,
        friends: FriendStore,
        events: EventStore,
        room_exists: RoomExists,
        is_room_host: RoomHost,
        notifier: ChangeNotifier,
        ids: IdGenerator,
        clock: Clock,
    ) -> None:
        self._friends = friends
        self._events = events
        self._room_exists = room_exists
        self._is_room_host = is_room_host
        self._notifier = notifier
        self._ids = ids
        self._clock = clock

    def request_join(self, me: Account, host_id: str, room_id: str) -> None:
        """Tells a friend's current room host that this person would like an invitation."""
        if not self._friends.are_friends(me.account_id, host_id):
            raise ForbiddenError("NotFriends", "Only friends can request room entry")
        if not self._room_exists(room_id) or not self._is_room_host(host_id, room_id):
            raise ForbiddenError("NotRoomHost", "Room entry can be requested only from its host")
        if me.room_id is not None:
            raise ConflictError("AlreadyInRoom", "Leave the current room before requesting another")
        self._events.add_notice(
            host_id, NoticeKind.JOIN_REQUESTED, me.account_id, room_id, self._clock.now()
        )
        self._notifier.changed((host_id,))

    def invite(self, me: Account, friend_id: str, room_id: str) -> RoomInvite:
        if not self._friends.are_friends(me.account_id, friend_id):
            raise ForbiddenError("NotFriends", "Only friends can be invited")
        if me.room_id != room_id or not self._room_exists(room_id):
            raise ForbiddenError("NotInRoom", "Invite others only from the room you are in")
        pending = self._events.pending_invite(me.account_id, friend_id, room_id)
        if pending is not None:
            return pending
        invite = RoomInvite(
            invite_id=self._ids.new(),
            from_account_id=me.account_id,
            to_account_id=friend_id,
            room_id=room_id,
            state=InviteState.PENDING,
            created_at=self._clock.now(),
        )
        self._events.add_invite(invite)
        self._notifier.changed((friend_id,))
        return invite

    def accept(self, me: Account, invite_id: str) -> str:
        """Returns the room to join."""
        invite = self._answer(me, invite_id, InviteState.ACCEPTED, NoticeKind.INVITE_ACCEPTED)
        return invite.room_id

    def decline(self, me: Account, invite_id: str) -> None:
        self._answer(me, invite_id, InviteState.DECLINED, NoticeKind.INVITE_DECLINED)

    def room_closed(self, room_id: str) -> None:
        """Invitations into a room that has closed expire; the invited stop seeing them."""
        invites = self._events.pending_invites_into(room_id)
        for invite in invites:
            self._events.save_invite(replace(invite, state=InviteState.EXPIRED))
        if invites:
            self._notifier.changed(tuple(invite.to_account_id for invite in invites))

    def pending(self, me: Account) -> tuple[RoomInvite, ...]:
        """Invites still waiting for an answer; one into a room that has closed has expired."""
        waiting = []
        for invite in self._events.pending_invites_to(me.account_id):
            if self._room_exists(invite.room_id):
                waiting.append(invite)
            else:
                self._events.save_invite(replace(invite, state=InviteState.EXPIRED))
        return tuple(waiting)

    def _answer(
        self, me: Account, invite_id: str, state: InviteState, notice: NoticeKind
    ) -> RoomInvite:
        invite = self._events.invite(invite_id)
        if invite is None or invite.to_account_id != me.account_id:
            raise NotFoundError("InviteNotFound", "This invitation was not found")
        if invite.state is not InviteState.PENDING:
            raise ConflictError("InviteAnswered", "This invitation was already answered")
        if state is InviteState.ACCEPTED and not self._room_exists(invite.room_id):
            self._events.save_invite(replace(invite, state=InviteState.EXPIRED))
            raise NotFoundError("RoomNotFound", "The room has closed", roomId=invite.room_id)
        answered = replace(invite, state=state)
        self._events.save_invite(answered)
        now = self._clock.now()
        self._events.add_notice(invite.from_account_id, notice, me.account_id, invite.room_id, now)
        self._notifier.changed((me.account_id, invite.from_account_id))
        return answered
