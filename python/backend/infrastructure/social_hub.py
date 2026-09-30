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
            return len(sockets) == 1

    def disconnect(self, account_id: str, socket: Socket) -> bool:
        """Removes the socket; True when the account has no open app left."""
        with self._lock:
            sockets = self._sockets.get(account_id, set())
            sockets.discard(socket)
            if sockets:
                return False
            self._sockets.pop(account_id, None)
            return True

    def changed(self, account_ids: tuple[str, ...]) -> None:
        """Safe from any thread: pushes a fresh view to every connected account among these."""
        loop = self._loop
        if loop is None:
            return
        for account_id in set(account_ids):
            if self.online(account_id):
                loop.call_soon_threadsafe(self._spawn, account_id)

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
                await socket.send_json(view)
            except (WebSocketDisconnect, RuntimeError, OSError):
                # A socket closing meanwhile is removed by its own handler.
                logger.debug("Social push to a closing socket was dropped", exc_info=True)
