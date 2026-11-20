from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace

import anyio

from backend.api import system_routes
from backend.api.system_routes import events as event_response
from backend.infrastructure.event_stream import EventStream
from tests.fakes import FakeClock


async def _subscribed(events: EventStream) -> None:
    with anyio.fail_after(2):
        while not events._subscribers and not events._async_subscribers:
            await anyio.sleep(0)


def _connection(events: EventStream):
    disconnected = asyncio.Event()
    chunks = []

    async def receive():
        await disconnected.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.body":
            chunks.append(message["body"])

    response = event_response(SimpleNamespace(events=events))
    task = asyncio.create_task(
        response({"type": "http", "asgi": {"spec_version": "2.3"}}, receive, send)
    )
    return disconnected, chunks, task


def test_idle_event_stream_does_not_reserve_an_api_worker() -> None:
    async def scenario():
        events = EventStream(FakeClock())
        disconnected, _chunks, task = _connection(events)
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
        events = EventStream(FakeClock())
        disconnected, _chunks, task = _connection(events)
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
            await asyncio.sleep(0)
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
        events = EventStream(FakeClock())
        disconnected, chunks, task = _connection(events)
        await _subscribed(events)
        try:
            events.publish("job.changed", {"jobId": "job", "state": "Succeeded"})
            with anyio.fail_after(2):
                while not chunks:
                    await anyio.sleep(0)
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
        await asyncio.sleep(0)
        assert subscriber.empty()
        await asyncio.wait_for(subscriber.join(), 1)
        with events.subscribe_async() as replacement:
            events.publish("replacement", {})
            assert (await asyncio.wait_for(replacement.get(), 1)).event_type == "replacement"
            replacement.task_done()

    asyncio.run(scenario())
