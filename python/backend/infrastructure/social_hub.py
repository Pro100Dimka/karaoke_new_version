from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass
from typing import Callable, Literal, Protocol

import anyio
from starlette.websockets import WebSocketDisconnect

logger = logging.getLogger(__name__)


class Socket(Protocol):
    async def send_json(self, data: object) -> None: ...

    async def close(self, code: int = 1000) -> None: ...


@dataclass(slots=True)
class _SnapshotDelivery:
    pending: dict[str, tuple[object, tuple[str, str] | None]]
    task: asyncio.Task[None] | None = None


class SocialHub:
    """
    The open apps' sockets, by account. Being connected is being online. Whatever changes for an
    account (a request, an invite, an answer, a friend coming online) is pushed to its sockets at
    once, so no app ever has to ask the server again and again.
    """

    def __init__(self) -> None:
        self._sockets: dict[str, set[Socket]] = {}
        self._rooms: dict[str, str] = {}
        self._send_locks: dict[Socket, asyncio.Lock] = {}
        self._deliveries: dict[Socket, _SnapshotDelivery] = {}
        self._changes: dict[str, bool] = {}
        self._lock = threading.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._render: Callable[[str], object] | None = None
        self._tasks: set[asyncio.Task[None]] = set()

    def start(self, render: Callable[[str], object]) -> None:
        """`render` builds what an account's app is sent; called on a worker thread."""
        self._loop = asyncio.get_running_loop()
        self._render = render

    def online(self, account_id: str) -> bool:
        with self._lock:
            return bool(self._sockets.get(account_id))

    def connect(self, account_id: str, socket: Socket) -> bool:
        """Adds the socket; True when this is the account's first open app."""
        with self._lock:
            sockets = self._sockets.setdefault(account_id, set())
            sockets.add(socket)
            self._send_locks.setdefault(socket, asyncio.Lock())
            return len(sockets) == 1

    def set_room(self, account_id: str, room_id: str | None) -> None:
        """Tracks which connected accounts should receive ephemeral room events."""
        with self._lock:
            if room_id is None:
                self._rooms.pop(account_id, None)
            else:
                self._rooms[account_id] = room_id

    def revoke(self, account_ids: tuple[str, ...]) -> None:
        with self._lock:
            sockets = tuple(
                socket for account in account_ids for socket in self._sockets.pop(account, ())
            )
            for account in account_ids:
                self._rooms.pop(account, None)
            for socket in sockets:
                self._forget_socket(socket)
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self._spawn_close, sockets)

    def _spawn_close(self, sockets: tuple[Socket, ...]) -> None:
        task = asyncio.create_task(self._close(sockets))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _close(self, sockets: tuple[Socket, ...]) -> None:
        for socket in sockets:
            try:
                await socket.close(code=1008)
            except (WebSocketDisconnect, RuntimeError, OSError):
                logger.debug("Revoked socket was already closed", exc_info=True)

    def disconnect(self, account_id: str, socket: Socket) -> bool:
        """Removes the socket; True when the account has no open app left."""
        with self._lock:
            sockets = self._sockets.get(account_id, set())
            sockets.discard(socket)
            self._forget_socket(socket)
            if sockets:
                return False
            self._sockets.pop(account_id, None)
            self._rooms.pop(account_id, None)
            return True

    def _forget_socket(self, socket: Socket) -> None:
        self._send_locks.pop(socket, None)
        delivery = self._deliveries.pop(socket, None)
        if delivery is not None and delivery.task is not None and self._loop is not None:
            self._loop.call_soon_threadsafe(delivery.task.cancel)

    def changed(self, account_ids: tuple[str, ...]) -> None:
        """Safe from any thread: pushes a fresh view to every connected account among these."""
        loop = self._loop
        if loop is None:
            return
        scheduled = []
        with self._lock:
            for account_id in set(account_ids):
                if not self._sockets.get(account_id):
                    continue
                if account_id not in self._changes:
                    scheduled.append(account_id)
                self._changes[account_id] = True
        for account_id in scheduled:
            loop.call_soon_threadsafe(self._spawn, account_id)

    def broadcast_room(self, room_id: str, message: object) -> None:
        """Keep only current room meters; a slow app must not queue obsolete levels for others."""
        with self._lock:
            recipients = [
                (account_id, socket)
                for account_id, current_room in self._rooms.items()
                if current_room == room_id
                for socket in self._sockets.get(account_id, ())
            ]
        for account_id, socket in recipients:
            self._queue_snapshot(socket, "room", message, room=(account_id, room_id))

    def _queue_snapshot(
        self,
        socket: Socket,
        channel: Literal["inbox", "room"],
        message: object,
        *,
        room: tuple[str, str] | None = None,
    ) -> None:
        loop = self._loop
        if loop is None:
            return
        with self._lock:
            if socket not in self._send_locks:
                return
            delivery = self._deliveries.get(socket)
            scheduled = delivery is None
            if delivery is None:
                delivery = _SnapshotDelivery({})
                self._deliveries[socket] = delivery
            delivery.pending[channel] = (message, room)
        if scheduled:
            loop.call_soon_threadsafe(self._spawn_delivery, socket, delivery)

    def _spawn_delivery(self, socket: Socket, delivery: _SnapshotDelivery) -> None:
        with self._lock:
            if self._deliveries.get(socket) is not delivery:
                return
            task = asyncio.create_task(self._deliver(socket, delivery))
            delivery.task = task
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _deliver(self, socket: Socket, delivery: _SnapshotDelivery) -> None:
        try:
            while True:
                with self._lock:
                    if self._deliveries.get(socket) is not delivery:
                        return
                    if not delivery.pending:
                        self._deliveries.pop(socket)
                        return
                    message, room = delivery.pending.pop(next(iter(delivery.pending)))
                await self._send(socket, message, room=room)
        except (WebSocketDisconnect, RuntimeError, OSError):
            logger.debug("Snapshot push to a closing socket was dropped", exc_info=True)
        finally:
            with self._lock:
                if self._deliveries.get(socket) is delivery:
                    self._deliveries.pop(socket)

    async def _send(
        self, socket: Socket, message: object, *, room: tuple[str, str] | None = None
    ) -> None:
        with self._lock:
            lock = self._send_locks.get(socket)
        if lock is None:
            return
        async with lock:
            with self._lock:
                if self._send_locks.get(socket) is not lock:
                    return
                if room is not None and self._rooms.get(room[0]) != room[1]:
                    return
            await socket.send_json(message)

    def _spawn(self, account_id: str) -> None:
        task = asyncio.create_task(self._push_changes(account_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _push_changes(self, account_id: str) -> None:
        complete = False
        try:
            while True:
                with self._lock:
                    if not self._changes[account_id] or not self._sockets.get(account_id):
                        self._changes.pop(account_id)
                        complete = True
                        return
                    self._changes[account_id] = False
                # Notices are persisted in the inbox. Render a fresh snapshot after changes
                # during this render, instead of racing a worker and stale payload per change.
                await self.push(account_id)
        finally:
            if not complete:
                with self._lock:
                    self._changes.pop(account_id, None)

    async def push(self, account_id: str) -> None:
        render = self._render
        if render is None:
            return
        view = await anyio.to_thread.run_sync(render, account_id)
        with self._lock:
            sockets = tuple(self._sockets.get(account_id, ()))
        for socket in sockets:
            self._queue_snapshot(socket, "inbox", view)

    async def send(self, socket: Socket, message: object) -> None:
        """Sends a protocol reply through the same serialization lock as inbox pushes."""
        await self._send(socket, message)
