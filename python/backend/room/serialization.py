from __future__ import annotations

import threading
from functools import wraps
from typing import Callable, Concatenate, ParamSpec, TypeVar

_P = ParamSpec("_P")
_R = TypeVar("_R")
_S = TypeVar("_S")

_registry_lock = threading.Lock()
_room_locks: dict[str, threading.RLock] = {}


def room_lock(room_id: str) -> threading.RLock:
    """The one lock of a room: its commands run one at a time, other rooms' commands run in parallel."""
    with _registry_lock:
        lock = _room_locks.get(room_id)
        if lock is None:
            lock = _room_locks[room_id] = threading.RLock()
        return lock


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
