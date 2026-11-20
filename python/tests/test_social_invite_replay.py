from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from threading import Barrier

import pytest

from backend.api.social_routes import accept_invite
from backend.bootstrap.social_wiring import SocialCases, build_social_cases
from backend.domain_errors import ConflictError, NotFoundError
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.social.domain import Account, InviteState, RoomInvite

_HOST_DEVICE = "host".ljust(40, "-")
_GUEST_DEVICE = "guest".ljust(40, "-")


@dataclass
class InvitedFriends:
    social: SocialCases
    host: Account
    guest: Account
    invite: RoomInvite
    rooms: set[str]
    changes: list[tuple[str, ...]]


@pytest.fixture
def invited_friends(monkeypatch: pytest.MonkeyPatch) -> InvitedFriends:
    rooms = {"room"}
    social = build_social_cases(None, UuidGenerator(), UtcClock(), rooms.__contains__)
    host = social.accounts.identify(_HOST_DEVICE)
    guest = social.accounts.identify(_GUEST_DEVICE)
    social.friends.request(host, guest.account_id)
    social.friends.accept(guest, host.account_id)
    social.inbox.view(host.account_id)  # Consume the unrelated friendship notice.
    invite = social.invites.invite(replace(host, room_id="room"), guest.account_id, "room")
    changes: list[tuple[str, ...]] = []
    monkeypatch.setattr(social.hub, "changed", changes.append)
    return InvitedFriends(social, host, guest, invite, rooms, changes)


def test_accepted_invitation_replays_its_room_after_response_loss(
    invited_friends: InvitedFriends,
) -> None:
    case = invited_friends
    # The server commits, but the response never reaches the client that needs the room ID.
    accept_invite(case.invite.invite_id, case, _GUEST_DEVICE)
    stored = case.social.invites._events.invite(case.invite.invite_id)
    assert stored is not None and stored.state is InviteState.ACCEPTED
    assert case.social.inbox.view(case.guest.account_id).invites == ()
    notices = case.social.inbox.view(case.host.account_id).notices
    assert [notice.kind.value for notice, _ in notices] == ["InviteAccepted"]
    assert case.changes == [(case.guest.account_id, case.host.account_id)]

    replay = accept_invite(case.invite.invite_id, case, _GUEST_DEVICE)

    assert replay.model_dump(by_alias=True) == {"roomId": "room"}
    assert case.social.invites._events.invite(case.invite.invite_id) == stored
    assert case.social.inbox.view(case.host.account_id).notices == ()
    assert case.changes == [(case.guest.account_id, case.host.account_id)]


def test_concurrent_accepts_return_the_room_and_notify_only_once(
    invited_friends: InvitedFriends,
) -> None:
    case = invited_friends
    start = Barrier(2, timeout=5)

    def accept() -> str:
        start.wait()
        return accept_invite(case.invite.invite_id, case, _GUEST_DEVICE).room_id

    with ThreadPoolExecutor(max_workers=2) as workers:
        answers = [workers.submit(accept) for _ in range(2)]
        assert [answer.result(timeout=5) for answer in answers] == ["room", "room"]

    notices = case.social.inbox.view(case.host.account_id).notices
    assert [notice.kind.value for notice, _ in notices] == ["InviteAccepted"]
    assert case.changes == [(case.guest.account_id, case.host.account_id)]


@pytest.mark.parametrize("device", [_HOST_DEVICE, "outsider".ljust(40, "-")])
def test_only_the_recipient_can_replay_an_accepted_invitation(
    invited_friends: InvitedFriends, device: str
) -> None:
    case = invited_friends
    accept_invite(case.invite.invite_id, case, _GUEST_DEVICE)

    with pytest.raises(NotFoundError) as raised:
        accept_invite(case.invite.invite_id, case, device)

    assert raised.value.code == "InviteNotFound"


@pytest.mark.parametrize("state", [InviteState.DECLINED, InviteState.EXPIRED])
def test_replay_does_not_accept_a_declined_or_expired_invitation(
    invited_friends: InvitedFriends, state: InviteState
) -> None:
    case = invited_friends
    if state is InviteState.DECLINED:
        case.social.invites.decline(case.guest, case.invite.invite_id)
    else:
        case.rooms.clear()
        case.social.invites.room_closed("room")

    with pytest.raises(ConflictError) as raised:
        accept_invite(case.invite.invite_id, case, _GUEST_DEVICE)

    assert raised.value.code == "InviteAnswered"
    stored = case.social.invites._events.invite(case.invite.invite_id)
    assert stored is not None and stored.state is state


def test_replay_does_not_return_an_accepted_invitation_into_a_closed_room(
    invited_friends: InvitedFriends,
) -> None:
    case = invited_friends
    accept_invite(case.invite.invite_id, case, _GUEST_DEVICE)
    case.rooms.clear()
    case.social.invites.room_closed("room")

    with pytest.raises(ConflictError) as raised:
        accept_invite(case.invite.invite_id, case, _GUEST_DEVICE)

    assert raised.value.code == "InviteAnswered"
    stored = case.social.invites._events.invite(case.invite.invite_id)
    assert stored is not None and stored.state is InviteState.ACCEPTED
    assert case.changes == [(case.guest.account_id, case.host.account_id)]
