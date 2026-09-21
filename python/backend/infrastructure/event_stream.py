from __future__ import annotations

import queue
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
        self._clock = clock
        self._capacity = subscriber_capacity
        self._subscribers: set[queue.Queue[BackendEvent]] = set()
        self._lock = threading.Lock()

    def publish(self, event_type: str, data: Mapping[str, object]) -> None:
        event = BackendEvent(event_type, self._clock.now(), data)
        with self._lock:
            subscribers = tuple(self._subscribers)
        for subscriber in subscribers:
            self._offer(subscriber, event)

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

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

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
            return
        subscriber.put_nowait(event)
