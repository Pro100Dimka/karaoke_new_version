from __future__ import annotations

import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Iterable

from backend.social.domain import Account

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS accounts (account_id TEXT PRIMARY KEY, device_key TEXT UNIQUE,"
    " display_name TEXT NOT NULL, friend_code TEXT NOT NULL UNIQUE,"
    " transfer_code TEXT NOT NULL UNIQUE, avatar_version INTEGER NOT NULL,"
    " created_at TEXT NOT NULL, last_seen_at TEXT, room_id TEXT)",
    "CREATE TABLE IF NOT EXISTS avatars (account_id TEXT PRIMARY KEY, mime TEXT NOT NULL,"
    " data BLOB NOT NULL)",
    "CREATE TABLE IF NOT EXISTS participant_accounts (participant_id TEXT PRIMARY KEY,"
    " account_id TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS friendships (first_id TEXT NOT NULL, second_id TEXT NOT NULL,"
    " since TEXT NOT NULL, PRIMARY KEY (first_id, second_id))",
    "CREATE TABLE IF NOT EXISTS friend_requests (from_id TEXT NOT NULL, to_id TEXT NOT NULL,"
    " created_at TEXT NOT NULL, PRIMARY KEY (from_id, to_id))",
    "CREATE TABLE IF NOT EXISTS invites (invite_id TEXT PRIMARY KEY, from_id TEXT NOT NULL,"
    " to_id TEXT NOT NULL, room_id TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS invites_to ON invites (to_id, state)",
    "CREATE TABLE IF NOT EXISTS notices (notice_id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " account_id TEXT NOT NULL, kind TEXT NOT NULL, other_id TEXT NOT NULL, room_id TEXT,"
    " created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS visits (visit_id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " room_id TEXT NOT NULL, participant_id TEXT NOT NULL, account_id TEXT,"
    " display_name TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT)",
    "CREATE INDEX IF NOT EXISTS visits_room ON visits (room_id, left_at)",
    "CREATE INDEX IF NOT EXISTS visits_account ON visits (account_id, joined_at)",
    "CREATE INDEX IF NOT EXISTS visits_participant ON visits (participant_id)",
)

Row = tuple[object, ...]


def when(value: object) -> datetime | None:
    return None if value is None else datetime.fromisoformat(str(value))


def stamp(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


class SocialDatabase:
    """One SQLite file (or memory, for tests and a server without storage) for accounts and friends."""

    def __init__(self, path: Path | None) -> None:
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # One connection shared by the server's worker threads, serialised by the lock.
        self._connection = sqlite3.connect(
            ":memory:" if path is None else path, timeout=10, check_same_thread=False
        )
        with self._lock, self._connection:
            if path is not None:
                self._connection.execute("PRAGMA journal_mode=WAL")
            for statement in _SCHEMA:
                self._connection.execute(statement)

    def rows(self, sql: str, parameters: Iterable[object] = ()) -> list[Row]:
        with self._lock:
            return list(self._connection.execute(sql, tuple(parameters)).fetchall())

    def write(self, sql: str, parameters: Iterable[object] = ()) -> None:
        with self._lock, self._connection:
            self._connection.execute(sql, tuple(parameters))

    def take(self, select: str, delete: str, parameters: Iterable[object] = ()) -> list[Row]:
        """Reads rows and removes them in one step, so no reader sees them twice."""
        values = tuple(parameters)
        with self._lock, self._connection:
            rows = list(self._connection.execute(select, values).fetchall())
            self._connection.execute(delete, values)
        return rows

    def write_all(self, statements: Iterable[tuple[str, tuple[object, ...]]]) -> None:
        """Several changes that stand or fall together."""
        with self._lock, self._connection:
            for sql, parameters in statements:
                self._connection.execute(sql, parameters)


_ACCOUNT_COLUMNS = (
    "account_id, display_name, friend_code, transfer_code, avatar_version, created_at,"
    " last_seen_at, room_id"
)


def _account(row: Row) -> Account:
    return Account(
        account_id=str(row[0]),
        display_name=str(row[1]),
        friend_code=str(row[2]),
        transfer_code=str(row[3]),
        avatar_version=int(str(row[4])),
        created_at=when(row[5]) or datetime.min,
        last_seen_at=when(row[6]),
        room_id=None if row[7] is None else str(row[7]),
    )


class SqliteAccountStore:
    def __init__(self, database: SocialDatabase) -> None:
        self._db = database

    def _one(self, where: str, value: str) -> Account | None:
        rows = self._db.rows(f"SELECT {_ACCOUNT_COLUMNS} FROM accounts WHERE {where} = ?", (value,))
        return _account(rows[0]) if rows else None

    def by_device(self, device_key: str) -> Account | None:
        return self._one("device_key", device_key)

    def by_id(self, account_id: str) -> Account | None:
        return self._one("account_id", account_id)

    def by_friend_code(self, friend_code: str) -> Account | None:
        return self._one("friend_code", friend_code)

    def by_transfer_code(self, transfer_code: str) -> Account | None:
        return self._one("transfer_code", transfer_code)

    def by_ids(self, account_ids: tuple[str, ...]) -> tuple[Account, ...]:
        if not account_ids:
            return ()
        marks = ",".join("?" * len(account_ids))
        sql = f"SELECT {_ACCOUNT_COLUMNS} FROM accounts WHERE account_id IN ({marks})"
        return tuple(_account(row) for row in self._db.rows(sql, account_ids))

    def add(self, account: Account, device_key: str) -> None:
        self._db.write(
            f"INSERT INTO accounts (device_key, {_ACCOUNT_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)",
            (device_key, *self._values(account)),
        )

    def save(self, account: Account) -> None:
        self._db.write(
            "UPDATE accounts SET display_name = ?, friend_code = ?, transfer_code = ?,"
            " avatar_version = ?, created_at = ?, last_seen_at = ?, room_id = ?"
            " WHERE account_id = ?",
            (*self._values(account)[1:], account.account_id),
        )

    @staticmethod
    def _values(account: Account) -> tuple[object, ...]:
        return (
            account.account_id,
            account.display_name,
            account.friend_code,
            account.transfer_code,
            account.avatar_version,
            stamp(account.created_at),
            stamp(account.last_seen_at),
            account.room_id,
        )

    def move_device(self, device_key: str, account_id: str) -> None:
        self._db.write_all(
            (
                ("UPDATE accounts SET device_key = NULL WHERE device_key = ?", (device_key,)),
                (
                    "UPDATE accounts SET device_key = ? WHERE account_id = ?",
                    (device_key, account_id),
                ),
            )
        )

    def set_avatar(self, account_id: str, mime: str, data: bytes) -> None:
        self._db.write(
            "INSERT INTO avatars (account_id, mime, data) VALUES (?, ?, ?) ON CONFLICT(account_id)"
            " DO UPDATE SET mime = excluded.mime, data = excluded.data",
            (account_id, mime, data),
        )

    def clear_avatar(self, account_id: str) -> None:
        self._db.write("DELETE FROM avatars WHERE account_id = ?", (account_id,))

    def avatar(self, account_id: str) -> tuple[str, bytes] | None:
        rows = self._db.rows("SELECT mime, data FROM avatars WHERE account_id = ?", (account_id,))
        if not rows or not isinstance(data := rows[0][1], bytes):
            return None
        return str(rows[0][0]), data

    def map_participant(self, participant_id: str, account_id: str) -> None:
        self._db.write(
            "INSERT INTO participant_accounts (participant_id, account_id) VALUES (?, ?)"
            " ON CONFLICT(participant_id) DO UPDATE SET account_id = excluded.account_id",
            (participant_id, account_id),
        )

    def accounts_of_participants(self, participant_ids: tuple[str, ...]) -> dict[str, str]:
        if not participant_ids:
            return {}
        marks = ",".join("?" * len(participant_ids))
        sql = f"SELECT participant_id, account_id FROM participant_accounts WHERE participant_id IN ({marks})"
        return {str(row[0]): str(row[1]) for row in self._db.rows(sql, participant_ids)}
