from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from functools import wraps
from typing import Callable, Concatenate, ParamSpec, Protocol, TypeVar

_P = ParamSpec("_P")
_R = TypeVar("_R")


class RoomLocks:
    """The rooms' locks of one server: a room's commands run one at a time, other rooms' in parallel."""

    def __init__(self) -> None:
        self._registry_lock = threading.Lock()
        # room id -> (its lock, how many commands hold it or wait for it). An entry lives only while
        # it is in use, so a long-running server does not keep a lock for every room it ever hosted.
        self._locks: dict[str, tuple[threading.RLock, int]] = {}

    @contextmanager
    def hold(self, room_id: str) -> Iterator[None]:
        with self._registry_lock:
            lock, users = self._locks.get(room_id, (threading.RLock(), 0))
            self._locks[room_id] = (lock, users + 1)
        try:
            with lock:
                yield
        finally:
            with self._registry_lock:
                users = self._locks[room_id][1] - 1
                if users:
                    self._locks[room_id] = (lock, users)
                else:
                    del self._locks[room_id]

    def in_use(self) -> int:
        """How many rooms currently have a lock (held or awaited)."""
        with self._registry_lock:
            return len(self._locks)


class _RoomCommand(Protocol):
    @property
    def room_locks(self) -> RoomLocks: ...


_S = TypeVar("_S", bound=_RoomCommand)


def serialized_by_room(
    execute: Callable[Concatenate[_S, str, _P], _R],
) -> Callable[Concatenate[_S, str, _P], _R]:
    """
    Every room command reads the room, changes it and saves it. The server handles requests in
    parallel, so two commands for the same room (three participants reporting Ready at once) would
    otherwise both read the same room and the later save would silently undo the earlier one.
    """

    @wraps(execute)
    def locked(self: _S, room_id: str, /, *args: _P.args, **kwargs: _P.kwargs) -> _R:
        with self.room_locks.hold(room_id):
            return execute(self, room_id, *args, **kwargs)

    return locked
