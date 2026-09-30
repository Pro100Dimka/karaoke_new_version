from __future__ import annotations

from datetime import datetime

from backend.infrastructure.sqlite_social import Row, SocialDatabase, stamp, when
from backend.social.domain import FriendRequest, InviteState, Notice, NoticeKind, RoomInvite, Visit


def _pair(first: str, second: str) -> tuple[str, str]:
    """A friendship is stored once, under its two accounts in a fixed order."""
    return (first, second) if first < second else (second, first)


def _request(row: Row) -> FriendRequest:
    return FriendRequest(str(row[0]), str(row[1]), when(row[2]) or datetime.min)


class SqliteFriendStore:
    def __init__(self, database: SocialDatabase) -> None:
        self._db = database

    def friend_ids(self, account_id: str) -> tuple[str, ...]:
        rows = self._db.rows(
            "SELECT CASE WHEN first_id = ? THEN second_id ELSE first_id END FROM friendships"
            " WHERE first_id = ? OR second_id = ?",
            (account_id, account_id, account_id),
        )
        return tuple(str(row[0]) for row in rows)

    def are_friends(self, first: str, second: str) -> bool:
        sql = "SELECT 1 FROM friendships WHERE first_id = ? AND second_id = ?"
        return bool(self._db.rows(sql, _pair(first, second)))

    def befriend(self, first: str, second: str, at: datetime) -> None:
        self._db.write(
            "INSERT OR IGNORE INTO friendships (first_id, second_id, since) VALUES (?, ?, ?)",
            (*_pair(first, second), stamp(at)),
        )

    def unfriend(self, first: str, second: str) -> None:
        sql = "DELETE FROM friendships WHERE first_id = ? AND second_id = ?"
        self._db.write(sql, _pair(first, second))

    def request(self, from_id: str, to_id: str) -> FriendRequest | None:
        rows = self._db.rows(
            "SELECT from_id, to_id, created_at FROM friend_requests WHERE from_id = ? AND to_id = ?",
            (from_id, to_id),
        )
        return _request(rows[0]) if rows else None

    def add_request(self, request: FriendRequest) -> None:
        self._db.write(
            "INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)",
            (request.from_account_id, request.to_account_id, stamp(request.created_at)),
        )

    def remove_request(self, from_id: str, to_id: str) -> None:
        sql = "DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?"
        self._db.write(sql, (from_id, to_id))

    def requests_to(self, account_id: str) -> tuple[FriendRequest, ...]:
        return self._requests("to_id", account_id)

    def requests_from(self, account_id: str) -> tuple[FriendRequest, ...]:
        return self._requests("from_id", account_id)

    def _requests(self, column: str, account_id: str) -> tuple[FriendRequest, ...]:
        rows = self._db.rows(
            f"SELECT from_id, to_id, created_at FROM friend_requests WHERE {column} = ?"
            " ORDER BY created_at",
            (account_id,),
        )
        return tuple(_request(row) for row in rows)


_INVITE_COLUMNS = "invite_id, from_id, to_id, room_id, state, created_at"


def _invite(row: Row) -> RoomInvite:
    return RoomInvite(
        invite_id=str(row[0]),
        from_account_id=str(row[1]),
        to_account_id=str(row[2]),
        room_id=str(row[3]),
        state=InviteState(str(row[4])),
        created_at=when(row[5]) or datetime.min,
    )


class SqliteEventStore:
    def __init__(self, database: SocialDatabase) -> None:
        self._db = database

    def add_invite(self, invite: RoomInvite) -> None:
        self._db.write(
            f"INSERT INTO invites ({_INVITE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)",
            (
                invite.invite_id,
                invite.from_account_id,
                invite.to_account_id,
                invite.room_id,
                invite.state.value,
                stamp(invite.created_at),
            ),
        )

    def invite(self, invite_id: str) -> RoomInvite | None:
        sql = f"SELECT {_INVITE_COLUMNS} FROM invites WHERE invite_id = ?"
        rows = self._db.rows(sql, (invite_id,))
        return _invite(rows[0]) if rows else None

    def save_invite(self, invite: RoomInvite) -> None:
        sql = "UPDATE invites SET state = ? WHERE invite_id = ?"
        self._db.write(sql, (invite.state.value, invite.invite_id))

    def pending_invites_to(self, account_id: str) -> tuple[RoomInvite, ...]:
        rows = self._db.rows(
            f"SELECT {_INVITE_COLUMNS} FROM invites WHERE to_id = ? AND state = ?"
            " ORDER BY created_at",
            (account_id, InviteState.PENDING.value),
        )
        return tuple(_invite(row) for row in rows)

    def pending_invites_into(self, room_id: str) -> tuple[RoomInvite, ...]:
        rows = self._db.rows(
            f"SELECT {_INVITE_COLUMNS} FROM invites WHERE room_id = ? AND state = ?",
            (room_id, InviteState.PENDING.value),
        )
        return tuple(_invite(row) for row in rows)

    def pending_invite(self, from_id: str, to_id: str, room_id: str) -> RoomInvite | None:
        rows = self._db.rows(
            f"SELECT {_INVITE_COLUMNS} FROM invites"
            " WHERE from_id = ? AND to_id = ? AND room_id = ? AND state = ?",
            (from_id, to_id, room_id, InviteState.PENDING.value),
        )
        return _invite(rows[0]) if rows else None

    def add_notice(
        self, account_id: str, kind: NoticeKind, other_id: str, room_id: str | None, at: datetime
    ) -> None:
        self._db.write(
            "INSERT INTO notices (account_id, kind, other_id, room_id, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (account_id, kind.value, other_id, room_id, stamp(at)),
        )

    def take_notices(self, account_id: str) -> tuple[Notice, ...]:
        """Each notice is handed out once: taking it removes it."""
        rows = self._db.take(
            "SELECT notice_id, account_id, kind, other_id, room_id, created_at FROM notices"
            " WHERE account_id = ?",
            "DELETE FROM notices WHERE account_id = ?",
            (account_id,),
        )
        notices = (
            Notice(
                notice_id=int(str(row[0])),
                account_id=str(row[1]),
                kind=NoticeKind(str(row[2])),
                other_account_id=str(row[3]),
                room_id=None if row[4] is None else str(row[4]),
                created_at=when(row[5]) or datetime.min,
            )
            for row in rows
        )
        return tuple(sorted(notices, key=lambda notice: notice.notice_id))


_VISIT_COLUMNS = "room_id, participant_id, account_id, display_name, joined_at, left_at"


def _visit(row: Row) -> Visit:
    return Visit(
        room_id=str(row[0]),
        participant_id=str(row[1]),
        account_id=None if row[2] is None else str(row[2]),
        display_name=str(row[3]),
        joined_at=when(row[4]) or datetime.min,
        left_at=when(row[5]),
    )


class SqliteVisitStore:
    def __init__(self, database: SocialDatabase) -> None:
        self._db = database

    def open_participants(self, room_id: str) -> tuple[str, ...]:
        sql = "SELECT participant_id FROM visits WHERE room_id = ? AND left_at IS NULL"
        return tuple(str(row[0]) for row in self._db.rows(sql, (room_id,)))

    def open_visit(self, visit: Visit) -> None:
        # A participant whose app already said who they are is known by account from the start.
        self._db.write(
            f"INSERT INTO visits ({_VISIT_COLUMNS}) VALUES (?, ?, COALESCE(?, (SELECT account_id"
            " FROM participant_accounts WHERE participant_id = ?)), ?, ?, ?)",
            (
                visit.room_id,
                visit.participant_id,
                visit.account_id,
                visit.participant_id,
                visit.display_name,
                stamp(visit.joined_at),
                stamp(visit.left_at),
            ),
        )

    def close_visits(self, room_id: str, participant_ids: tuple[str, ...], at: datetime) -> None:
        marks = ",".join("?" * len(participant_ids))
        self._db.write(
            f"UPDATE visits SET left_at = ? WHERE room_id = ? AND left_at IS NULL"
            f" AND participant_id IN ({marks})",
            (stamp(at), room_id, *participant_ids),
        )

    def claim_visits(self, participant_id: str, account_id: str) -> None:
        sql = "UPDATE visits SET account_id = ? WHERE participant_id = ? AND account_id IS NULL"
        self._db.write(sql, (account_id, participant_id))

    def recent_room_ids(self, account_id: str, limit: int) -> tuple[str, ...]:
        rows = self._db.rows(
            "SELECT room_id FROM visits WHERE account_id = ? GROUP BY room_id"
            " ORDER BY MAX(joined_at) DESC LIMIT ?",
            (account_id, limit),
        )
        return tuple(str(row[0]) for row in rows)

    def visits_in(self, room_ids: tuple[str, ...]) -> tuple[Visit, ...]:
        if not room_ids:
            return ()
        marks = ",".join("?" * len(room_ids))
        sql = f"SELECT {_VISIT_COLUMNS} FROM visits WHERE room_id IN ({marks})"
        return tuple(_visit(row) for row in self._db.rows(sql, room_ids))
