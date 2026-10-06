from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from functools import wraps
from typing import Callable, Concatenate, ParamSpec, TypeVar

_P = ParamSpec("_P")
_R = TypeVar("_R")
_S = TypeVar("_S")

_registry_lock = threading.Lock()
# room id -> (its lock, how many commands hold it or wait for it). An entry lives only while it is in
# use, so a long-running server does not keep a lock for every room it ever hosted.
_room_locks: dict[str, tuple[threading.RLock, int]] = {}


@contextmanager
def room_lock(room_id: str) -> Iterator[None]:
    """The one lock of a room: its commands run one at a time, other rooms' commands run in parallel."""
    with _registry_lock:
        lock, users = _room_locks.get(room_id, (threading.RLock(), 0))
        _room_locks[room_id] = (lock, users + 1)
    try:
        with lock:
            yield
    finally:
        with _registry_lock:
            users = _room_locks[room_id][1] - 1
            if users:
                _room_locks[room_id] = (lock, users)
            else:
                del _room_locks[room_id]


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
        with room_lock(room_id):
            return execute(self, room_id, *args, **kwargs)

    return locked
