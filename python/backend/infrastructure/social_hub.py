from __future__ import annotations

import asyncio
import logging
import threading
from typing import Callable, Protocol

import anyio
from starlette.websockets import WebSocketDisconnect

logger = logging.getLogger(__name__)


class Socket(Protocol):
    async def send_json(self, data: object) -> None: ...


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

    def disconnect(self, account_id: str, socket: Socket) -> bool:
        """Removes the socket; True when the account has no open app left."""
        with self._lock:
            sockets = self._sockets.get(account_id, set())
            sockets.discard(socket)
            self._send_locks.pop(socket, None)
            if sockets:
                return False
            self._sockets.pop(account_id, None)
            self._rooms.pop(account_id, None)
            return True

    def changed(self, account_ids: tuple[str, ...]) -> None:
        """Safe from any thread: pushes a fresh view to every connected account among these."""
        loop = self._loop
        if loop is None:
            return
        for account_id in set(account_ids):
            if self.online(account_id):
                loop.call_soon_threadsafe(self._spawn, account_id)

    def broadcast_room(self, room_id: str, message: object) -> None:
        """Safe from the UDP relay thread: pushes transient data to apps in one room."""
        loop = self._loop
        if loop is None:
            return
        with self._lock:
            account_ids = tuple(
                account_id for account_id, current_room in self._rooms.items()
                if current_room == room_id and self._sockets.get(account_id)
            )
        if account_ids:
            loop.call_soon_threadsafe(self._spawn_broadcast, account_ids, message)

    def _spawn_broadcast(self, account_ids: tuple[str, ...], message: object) -> None:
        task = asyncio.create_task(self._broadcast(account_ids, message))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _broadcast(self, account_ids: tuple[str, ...], message: object) -> None:
        with self._lock:
            sockets = tuple(
                socket
                for account_id in account_ids
                for socket in self._sockets.get(account_id, ())
            )
        for socket in sockets:
            try:
                await self._send(socket, message)
            except (WebSocketDisconnect, RuntimeError, OSError):
                logger.debug("Room push to a closing socket was dropped", exc_info=True)

    async def _send(self, socket: Socket, message: object) -> None:
        with self._lock:
            lock = self._send_locks.get(socket)
        if lock is None:
            return
        async with lock:
            await socket.send_json(message)

    def _spawn(self, account_id: str) -> None:
        task = asyncio.create_task(self.push(account_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def push(self, account_id: str) -> None:
        render = self._render
        if render is None:
            return
        view = await anyio.to_thread.run_sync(render, account_id)
        with self._lock:
            sockets = tuple(self._sockets.get(account_id, ()))
        for socket in sockets:
            try:
                await self._send(socket, view)
            except (WebSocketDisconnect, RuntimeError, OSError):
                # A socket closing meanwhile is removed by its own handler.
                logger.debug("Social push to a closing socket was dropped", exc_info=True)

    async def send(self, socket: Socket, message: object) -> None:
        """Sends a protocol reply through the same serialization lock as inbox pushes."""
        await self._send(socket, message)
