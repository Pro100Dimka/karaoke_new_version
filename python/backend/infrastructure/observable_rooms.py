from __future__ import annotations

import asyncio
import threading
import time
from dataclasses import dataclass
from typing import Callable

import anyio

from backend.room.domain import Room
from backend.room.ports import RoomRepository


@dataclass(frozen=True, slots=True)
class _ChangeWaiter:
    after: int
    loop: asyncio.AbstractEventLoop
    future: asyncio.Future[int]


class ObservableRoomRepository:
    """Change notifications without leaking transport concerns into room cases."""

    def __init__(self, inner: RoomRepository) -> None:
        self._inner = inner
        self._condition = threading.Condition()
        self._versions: dict[str, int] = {}
        self._sequence = 0
        self._listeners: list[Callable[[str, Room | None], None]] = []
        self._async_lock = threading.Lock()
        self._async_waiters: dict[str, set[_ChangeWaiter]] = {}

    def listen(self, listener: Callable[[str, Room | None], None]) -> None:
        """`listener` hears every saved room, and None for a removed one, after it is stored."""
        self._listeners.append(listener)

    def get(self, room_id: str) -> Room | None:
        return self._inner.get(room_id)

    def save(self, room: Room) -> Room:
        saved = self._inner.save(room)
        self._publish(saved.room_id)
        for listener in self._listeners:
            listener(saved.room_id, saved)
        return saved

    def delete(self, room_id: str) -> None:
        self._inner.delete(room_id)
        self._publish(room_id)
        for listener in self._listeners:
            listener(room_id, None)

    def list_ids(self) -> tuple[str, ...]:
        list_ids = getattr(self._inner, "list_ids")
        return tuple(list_ids())

    def version(self, room_id: str) -> int:
        with self._condition:
            return self._versions.get(room_id, 0)

    def wait_for_change(self, room_id: str, after: int, timeout: float = 25.0) -> int:
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._versions.get(room_id, 0) <= after and self._inner.get(room_id) is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._condition.wait(remaining)
            return self._versions.get(room_id, 0)

    async def wait_for_change_async(self, room_id: str, after: int, timeout: float = 25.0) -> int:
        deadline = time.monotonic() + timeout
        loop = asyncio.get_running_loop()
        waiter = _ChangeWaiter(after, loop, loop.create_future())
        with self._async_lock:
            self._async_waiters.setdefault(room_id, set()).add(waiter)
        try:
            # Subscribe before the snapshot read so a concurrent save/delete cannot be lost.
            # The repository may use SQLite; only this short read needs a shared worker.
            version, pending = await anyio.to_thread.run_sync(self._change_state, room_id, after)
            if not pending:
                return version
            try:
                return await asyncio.wait_for(waiter.future, max(0.0, deadline - time.monotonic()))
            except TimeoutError:
                return await anyio.to_thread.run_sync(self.version, room_id)
        finally:
            self._forget_async(room_id, waiter)
            waiter.future.cancel()

    def _change_state(self, room_id: str, after: int) -> tuple[int, bool]:
        with self._condition:
            version = self._versions.get(room_id, 0)
            return version, version <= after and self._inner.get(room_id) is not None

    def _forget_async(self, room_id: str, waiter: _ChangeWaiter) -> None:
        with self._async_lock:
            waiting = self._async_waiters.get(room_id)
            if waiting is not None:
                waiting.discard(waiter)
                if not waiting:
                    del self._async_waiters[room_id]

    def _notify_async(self, room_id: str, version: int, removed: bool) -> None:
        with self._async_lock:
            waiting = self._async_waiters.get(room_id, set())
            ready = {waiter for waiter in waiting if removed or version > waiter.after}
            waiting.difference_update(ready)
            if not waiting:
                self._async_waiters.pop(room_id, None)
        for waiter in ready:
            try:
                waiter.loop.call_soon_threadsafe(_complete_change, waiter.future, version)
            except RuntimeError:
                pass  # The owning request loop has already closed.

    def _publish(self, room_id: str) -> None:
        with self._condition:
            self._sequence += 1
            removed = self._inner.get(room_id) is None
            if removed:
                self._versions.pop(room_id, None)
            else:
                self._versions[room_id] = self._sequence
            self._condition.notify_all()
            self._notify_async(room_id, self._versions.get(room_id, 0), removed)


def _complete_change(future: asyncio.Future[int], version: int) -> None:
    if not future.done():
        future.set_result(version)
