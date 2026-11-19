from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event, Lock, RLock

import pytest

from backend.bootstrap.social_wiring import build_social_cases
from backend.domain_errors import ConflictError
from backend.infrastructure.clock import UtcClock
from backend.infrastructure.ids import UuidGenerator
from backend.infrastructure.sqlite_social_events import SqliteEventStore
from backend.social.domain import InviteState


def _contend_lookup(monkeypatch: pytest.MonkeyPatch, invites, method: str) -> Event:
    first_read, contended = Event(), Event()
    counters, lock = Lock(), RLock()

    class ObservedLock:
        attempts = 0

        def __enter__(self) -> None:
            with counters:
                self.attempts += 1
                if self.attempts >= 2:
                    contended.set()
            lock.acquire()

        def __exit__(self, *_args: object) -> None:
            lock.release()

    # Observe lock contention without delaying the winner until the loser acquires the lock.
    monkeypatch.setattr(invites, "_lock", ObservedLock(), raising=False)
    original = getattr(SqliteEventStore, method)
    reads = 0

    def lookup(store: SqliteEventStore, *args):
        nonlocal reads
        value = original(store, *args)
        with counters:
            reads += 1
            first = reads == 1
        if first:
            first_read.set()
            assert contended.wait(timeout=5), "the second operation did not contend"
        else:
            contended.set()
        return value

    monkeypatch.setattr(SqliteEventStore, method, lookup)
    return first_read


def _friends():
    social = build_social_cases(None, UuidGenerator(), UtcClock(), lambda _: True)
    host = social.accounts.identify("host".ljust(40, "-"))
    guest = social.accounts.identify("guest".ljust(40, "-"))
    social.friends.request(host, guest.account_id)
    social.friends.accept(guest, host.account_id)
    return social, replace(host, room_id="room"), guest


def test_concurrent_invites_create_one_pending_invitation(monkeypatch: pytest.MonkeyPatch) -> None:
    social, host, guest = _friends()
    first_read = _contend_lookup(monkeypatch, social.invites, "pending_invite")

    with ThreadPoolExecutor(max_workers=2) as workers:
        first = workers.submit(social.invites.invite, host, guest.account_id, "room")
        assert first_read.wait(timeout=5)
        second = workers.submit(social.invites.invite, host, guest.account_id, "room")
        invitations = (first.result(timeout=5), second.result(timeout=5))

    assert invitations[0].invite_id == invitations[1].invite_id
    assert len(social.invites.pending(guest)) == 1


def test_concurrent_answers_cannot_reverse_an_accepted_invitation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    social, host, guest = _friends()
    invite = social.invites.invite(host, guest.account_id, "room")
    first_read = _contend_lookup(monkeypatch, social.invites, "invite")

    with ThreadPoolExecutor(max_workers=2) as workers:
        accepted = workers.submit(social.invites.accept, guest, invite.invite_id)
        assert first_read.wait(timeout=5)
        declined = workers.submit(social.invites.decline, guest, invite.invite_id)
        assert accepted.result(timeout=5) == "room"
        with pytest.raises(ConflictError, match="already answered"):
            declined.result(timeout=5)

    stored = social.invites._events.invite(invite.invite_id)
    assert stored is not None and stored.state is InviteState.ACCEPTED
    notices = social.inbox.view(host.account_id).notices
    assert [notice.kind.value for notice, _ in notices] == ["FriendAccepted", "InviteAccepted"]
