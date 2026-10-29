from __future__ import annotations

import asyncio
import queue
import threading
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import AsyncIterator, Mapping

from backend.runtime import Clock


@dataclass(frozen=True, slots=True)
class BackendEvent:
    event_type: str
    created_at: datetime
    data: Mapping[str, object]


class EventStream:
    def __init__(self, clock: Clock, subscriber_capacity: int = 128) -> None:
        if subscriber_capacity < 1:
            raise ValueError("Subscriber capacity must be positive")
        self._clock = clock
        self._capacity = subscriber_capacity
        self._subscribers: set[queue.Queue[BackendEvent]] = set()
        self._async_subscribers: dict[asyncio.Queue[BackendEvent], asyncio.AbstractEventLoop] = {}
        self._lock = threading.Lock()

    def publish(self, event_type: str, data: Mapping[str, object]) -> None:
        event = BackendEvent(event_type, self._clock.now(), data)
        with self._lock:
            # Serialize overflow eviction with all publishers; consumers only remove items.
            for subscriber in self._subscribers:
                self._offer(subscriber, event)
            for async_subscriber, loop in self._async_subscribers.items():
                if not loop.is_closed():
                    loop.call_soon_threadsafe(self._offer_async, async_subscriber, event)

    @asynccontextmanager
    async def subscribe_async(self) -> AsyncIterator[asyncio.Queue[BackendEvent]]:
        subscriber: asyncio.Queue[BackendEvent] = asyncio.Queue(maxsize=self._capacity)
        with self._lock:
            self._async_subscribers[subscriber] = asyncio.get_running_loop()
        try:
            yield subscriber
        finally:
            with self._lock:
                self._async_subscribers.pop(subscriber, None)

    @staticmethod
    def _offer_async(subscriber: asyncio.Queue[BackendEvent], event: BackendEvent) -> None:
        if subscriber.full():
            while not subscriber.empty():
                subscriber.get_nowait()
            event = BackendEvent("resync", event.created_at, {})
        subscriber.put_nowait(event)

    @contextmanager
    def subscribe(self) -> Iterator[queue.Queue[BackendEvent]]:
        subscriber: queue.Queue[BackendEvent] = queue.Queue(maxsize=self._capacity)
        with self._lock:
            self._subscribers.add(subscriber)
        try:
            yield subscriber
        finally:
            with self._lock:
                self._subscribers.discard(subscriber)

    @staticmethod
    def _offer(subscriber: queue.Queue[BackendEvent], event: BackendEvent) -> None:
        try:
            subscriber.put_nowait(event)
            return
        except queue.Full:
            pass
        try:
            subscriber.get_nowait()
            subscriber.task_done()
        except queue.Empty:
            pass
        subscriber.put_nowait(event)
