from __future__ import annotations

import asyncio
import json
import threading
from contextlib import contextmanager
from types import SimpleNamespace

import anyio

from backend.api import system_routes
from backend.api.system_routes import events as event_response
from backend.infrastructure.event_stream import EventStream
from tests.fakes import FakeClock


class _ObservedEvents(EventStream):
    def __init__(self):
        super().__init__(FakeClock())
        self.subscribed = threading.Event()

    @contextmanager
    def subscribe(self):
        with super().subscribe() as subscriber:
            self.subscribed.set()
            yield subscriber

    @contextmanager
    def subscribe_async(self):
        with super().subscribe_async() as subscriber:
            self.subscribed.set()
            yield subscriber


async def _subscribed(events: _ObservedEvents) -> None:
    assert await anyio.to_thread.run_sync(events.subscribed.wait, 2)


async def _after_scheduled_callbacks() -> None:
    loop = asyncio.get_running_loop()
    finished = loop.create_future()
    loop.call_soon(finished.set_result, None)
    await finished


def _connection(events: EventStream):
    disconnected = asyncio.Event()
    sent = asyncio.Event()
    chunks = []

    async def receive():
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            chunks.append(message["body"])
            sent.set()

    response = event_response(SimpleNamespace(events=events))
    task = asyncio.create_task(
        response({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send)
    )
    return disconnected, chunks, task, sent


def test_idle_event_stream_does_not_reserve_an_api_worker() -> None:
    async def scenario():
        events = _ObservedEvents()
        disconnected, _chunks, task, _sent = _connection(events)
        await _subscribed(events)
        try:
            borrowed = anyio.to_thread.current_default_thread_limiter().borrowed_tokens
        finally:
            disconnected.set()
            events.publish("cleanup", {})
            await asyncio.wait_for(task, 2)
        assert borrowed == 0, "An idle event subscription occupied the shared control worker pool"

    asyncio.run(scenario())


def test_event_disconnect_finishes_without_waiting_for_a_heartbeat() -> None:
    async def scenario():
        events = _ObservedEvents()
        disconnected, _chunks, task, _sent = _connection(events)
        await _subscribed(events)
        disconnected.set()
        finished = False
        try:
            await asyncio.wait_for(asyncio.shield(task), 0.1)
            finished = True
        except TimeoutError:
            pass
        finally:
            events.publish("cleanup", {})
            await asyncio.wait_for(task, 2)
        assert finished, "Disconnect waited for the blocking 15-second event read"
        assert not events._subscribers and not events._async_subscribers

    asyncio.run(scenario())


def test_async_event_burst_is_bounded_before_the_event_loop_can_drain(monkeypatch) -> None:
    async def scenario():
        events = EventStream(FakeClock(), subscriber_capacity=4)
        loop = asyncio.get_running_loop()
        schedule = loop.call_soon_threadsafe
        scheduled = []

        def counted(*args, **kwargs):
            scheduled.append(args[0])
            return schedule(*args, **kwargs)

        monkeypatch.setattr(loop, "call_soon_threadsafe", counted)
        with events.subscribe_async() as subscriber:
            publisher = threading.Thread(
                target=lambda: [events.publish("job.changed", {"index": i}) for i in range(1000)]
            )
            publisher.start()
            publisher.join(2)
            assert not publisher.is_alive()
            assert len(scheduled) <= 1, f"One burst queued {len(scheduled)} event-loop callbacks"
            await _after_scheduled_callbacks()
            pending = []
            while not subscriber.empty():
                pending.append(subscriber.get_nowait())
                subscriber.task_done()
            assert len(pending) <= 4
            assert any(item.event_type == "resync" for item in pending)
            events.publish("job.changed", {"state": "Succeeded"})
            terminal = await asyncio.wait_for(subscriber.get(), 1)
            subscriber.task_done()
            assert terminal.data == {"state": "Succeeded"}
            await asyncio.wait_for(subscriber.join(), 1)

    asyncio.run(scenario())


def test_event_stream_preserves_sse_payload_and_unsubscribes() -> None:
    async def scenario():
        events = _ObservedEvents()
        disconnected, chunks, task, sent = _connection(events)
        await _subscribed(events)
        try:
            events.publish("job.changed", {"jobId": "job", "state": "Succeeded"})
            await asyncio.wait_for(sent.wait(), 2)
            assert chunks[0].startswith(b"data: ") and chunks[0].endswith(b"\n\n")
            payload = json.loads(chunks[0].removeprefix(b"data: "))
            assert payload["type"] == "job.changed"
            assert payload["data"] == {"jobId": "job", "state": "Succeeded"}
            assert payload["createdAt"]
        finally:
            disconnected.set()
            events.publish("cleanup", {})
            await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_idle_event_stream_still_sends_heartbeats(monkeypatch) -> None:
    monkeypatch.setattr(system_routes, "_EVENT_HEARTBEAT_SECONDS", 0.01)

    async def scenario():
        events = EventStream(FakeClock())
        response = event_response(SimpleNamespace(events=events))
        iterator = response.body_iterator
        try:
            assert await asyncio.wait_for(anext(iterator), 1) == ": heartbeat\n\n"
        finally:
            await iterator.aclose()
        assert not events._async_subscribers

    asyncio.run(scenario())


def test_async_event_delivery_preserves_order_and_drops_closed_subscribers() -> None:
    async def scenario():
        events = EventStream(FakeClock(), subscriber_capacity=4)
        with events.subscribe_async() as subscriber:
            for index in range(4):
                events.publish("ordered", {"index": index})
            for index in range(4):
                item = await asyncio.wait_for(subscriber.get(), 1)
                subscriber.task_done()
                assert item.data == {"index": index}
            events.publish("closed-before-delivery", {})
        await _after_scheduled_callbacks()
        assert subscriber.empty()
        await asyncio.wait_for(subscriber.join(), 1)
        with events.subscribe_async() as replacement:
            events.publish("replacement", {})
            assert (await asyncio.wait_for(replacement.get(), 1)).event_type == "replacement"
            replacement.task_done()

    asyncio.run(scenario())
