from __future__ import annotations

import queue
import asyncio
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Mapping

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
        self._async_subscribers: set[
            tuple[asyncio.AbstractEventLoop, asyncio.Queue[BackendEvent]]
        ] = set()
        self._lock = threading.Lock()

    def publish(self, event_type: str, data: Mapping[str, object]) -> None:
        event = BackendEvent(event_type, self._clock.now(), data)
        with self._lock:
            # Serialize overflow eviction with all publishers; consumers only remove items.
            for subscriber in self._subscribers:
                self._offer(subscriber, event)
            for loop, async_subscriber in self._async_subscribers:
                try:
                    loop.call_soon_threadsafe(self._offer_async, async_subscriber, event)
                except RuntimeError:
                    pass

    @contextmanager
    def subscribe_async(self) -> Iterator[asyncio.Queue[BackendEvent]]:
        subscriber: asyncio.Queue[BackendEvent] = asyncio.Queue(maxsize=self._capacity)
        entry = (asyncio.get_running_loop(), subscriber)
        with self._lock:
            self._async_subscribers.add(entry)
        try:
            yield subscriber
        finally:
            with self._lock:
                self._async_subscribers.discard(entry)

    @staticmethod
    def _offer_async(subscriber: asyncio.Queue[BackendEvent], event: BackendEvent) -> None:
        if subscriber.full():
            for _ in range(subscriber.qsize()):
                subscriber.get_nowait()
                subscriber.task_done()
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
