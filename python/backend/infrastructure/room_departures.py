from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

import anyio

from backend.domain_errors import DomainError

logger = logging.getLogger(__name__)


class RoomDepartures:
    """
    Someone whose app closed (or crashed) without leaving the room is taken out of it once the app
    has been gone longer than a restart or a reconnect takes. Leaving hands the room to another
    participant, or closes it when nobody is left, so no room is left behind for nobody.
    """

    def __init__(
        self,
        leave: Callable[[str, str], None],
        online: Callable[[str], bool],
        grace_seconds: float,
        wait: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._leave = leave
        self._online = online
        self._grace_seconds = grace_seconds
        self._wait = wait
        self._tasks: set[asyncio.Task[None]] = set()
        # Only the latest departure of an account counts: one that reconnected and went away again
        # is given the whole grace from its latest departure.
        self._departures: dict[str, int] = {}

    def gone(self, account_id: str, participant_id: str, room_id: str) -> None:
        """The account's last app went away while in `room_id`; runs in the server's event loop."""
        departure = self._departures.get(account_id, 0) + 1
        self._departures[account_id] = departure
        task = asyncio.create_task(
            self._leave_later(account_id, participant_id, room_id, departure)
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _leave_later(
        self, account_id: str, participant_id: str, room_id: str, departure: int
    ) -> None:
        await self._wait(self._grace_seconds)
        if self._departures.get(account_id) != departure:
            return
        del self._departures[account_id]
        if self._online(account_id):
            return
        try:
            await anyio.to_thread.run_sync(self._leave, room_id, participant_id)
        except DomainError:
            return  # the room closed or the participant left meanwhile
        logger.info(
            "Participant %s left room %s: the app closed without leaving", participant_id, room_id
        )

    async def settled(self) -> None:
        """Waits until every departure waiting now has been decided."""
        await asyncio.gather(*self._tasks)
