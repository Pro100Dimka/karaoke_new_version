from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from backend.infrastructure.social_hub import SocialHub


class Socket:
    def __init__(self, *, blocked: bool = False) -> None:
        self.messages: list[object] = []
        self.entered = asyncio.Event()
        self.received = asyncio.Event()
        self.release = asyncio.Event()
        if not blocked:
            self.release.set()

    async def send_json(self, message: object) -> None:
        self.entered.set()
        await self.release.wait()
        self.messages.append(message)
        self.received.set()


def connect(hub: SocialHub, name: str, socket: Socket) -> None:
    hub.connect(name, socket)
    hub.set_room(name, "room")


async def scheduled_callbacks_finished() -> None:
    # A callback fence runs after every callback already queued by the producer.
    loop = asyncio.get_running_loop()
    completed = loop.create_future()
    loop.call_soon(completed.set_result, None)
    await completed


async def settled(hub: SocialHub) -> None:
    await scheduled_callbacks_finished()
    while hub._tasks:
        results = await asyncio.gather(*tuple(hub._tasks), return_exceptions=True)
        assert all(
            result is None or isinstance(result, asyncio.CancelledError) for result in results
        )
        await scheduled_callbacks_finished()


def test_voice_level_bursts_do_not_queue_a_callback_for_every_update(monkeypatch) -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda account: {"type": "inbox", "account": account})
        socket = Socket()
        connect(hub, "anna", socket)
        loop = asyncio.get_running_loop()
        schedule = loop.call_soon_threadsafe
        calls = 0

        def counted(*args, **kwargs):
            nonlocal calls
            calls += 1
            return schedule(*args, **kwargs)

        with monkeypatch.context() as changes:
            changes.setattr(loop, "call_soon_threadsafe", counted)
            for value in range(1000):
                hub.broadcast_room("room", {"type": "voiceLevels", "value": value})
        await asyncio.wait_for(settled(hub), timeout=2)
        assert calls <= 1, f"One socket accumulated {calls} callbacks before the loop resumed"
        assert socket.messages == [{"type": "voiceLevels", "value": 999}]

    asyncio.run(scenario())


def test_presence_acknowledgements_are_not_coalesced_with_room_meters() -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda account: {"type": "inbox", "account": account})
        socket = Socket(blocked=True)
        connect(hub, "anna", socket)
        hub.broadcast_room("room", {"type": "voiceLevels", "value": 0})
        await asyncio.wait_for(socket.entered.wait(), timeout=1)
        replies = [
            asyncio.create_task(hub.send(socket, {"type": "presenceAck", "revision": revision}))
            for revision in (1, 2)
        ]
        for value in range(1, 101):
            hub.broadcast_room("room", {"type": "voiceLevels", "value": value})
        socket.release.set()
        await asyncio.wait_for(asyncio.gather(*replies), timeout=1)
        await asyncio.wait_for(settled(hub), timeout=2)
        assert [message for message in socket.messages if message["type"] == "presenceAck"] == [
            {"type": "presenceAck", "revision": 1},
            {"type": "presenceAck", "revision": 2},
        ]
        assert socket.messages[-1] == {"type": "voiceLevels", "value": 100}

    asyncio.run(scenario())


def test_disconnect_releases_a_stalled_room_delivery() -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda account: {"type": "inbox", "account": account})
        socket = Socket(blocked=True)
        connect(hub, "anna", socket)
        hub.broadcast_room("room", {"type": "voiceLevels", "value": 0.5})
        await asyncio.wait_for(socket.entered.wait(), timeout=1)
        hub.disconnect("anna", socket)
        await asyncio.wait_for(settled(hub), timeout=1)
        assert not socket.messages
        assert not hub._deliveries

    asyncio.run(scenario())


def test_slow_room_socket_does_not_delay_a_healthy_recipient() -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda account: {"type": "inbox", "account": account})
        slow, healthy = Socket(blocked=True), Socket()
        connect(hub, "anna", slow)
        connect(hub, "boris", healthy)
        update = {"type": "voiceLevels", "value": 0.7}
        hub.broadcast_room("room", update)
        try:
            await asyncio.wait_for(slow.entered.wait(), timeout=1)
            await asyncio.wait_for(healthy.received.wait(), timeout=0.5)
            assert not slow.messages
            assert healthy.messages == [update]
        finally:
            slow.release.set()
            await asyncio.wait_for(settled(hub), timeout=2)

    asyncio.run(scenario())


def test_slow_socket_receives_latest_levels_without_replaying_the_backlog() -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda account: {"type": "inbox", "account": account})
        socket = Socket(blocked=True)
        connect(hub, "anna", socket)
        hub.broadcast_room("room", {"type": "voiceLevels", "value": 0})
        await asyncio.wait_for(socket.entered.wait(), timeout=1)
        try:
            for value in range(1, 101):
                hub.broadcast_room("room", {"type": "voiceLevels", "value": value})
                await scheduled_callbacks_finished()
        finally:
            socket.release.set()
        await asyncio.wait_for(settled(hub), timeout=2)
        assert socket.messages == [
            {"type": "voiceLevels", "value": 0},
            {"type": "voiceLevels", "value": 100},
        ]

    asyncio.run(scenario())


def test_queued_levels_are_discarded_after_leaving_the_room(monkeypatch) -> None:
    async def scenario() -> None:
        hub = SocialHub()
        hub.start(lambda account: {"type": "inbox", "account": account})
        socket = Socket(blocked=True)
        connect(hub, "anna", socket)
        sending_levels = asyncio.Event()
        send = hub._send

        async def observe_send(socket, message, *, room=None):
            if room is not None:
                sending_levels.set()
            await send(socket, message, room=room)

        monkeypatch.setattr(hub, "_send", observe_send)
        acknowledgement = {"type": "presenceAck", "revision": 1}
        reply = asyncio.create_task(hub.send(socket, acknowledgement))
        await asyncio.wait_for(socket.entered.wait(), timeout=1)
        hub.broadcast_room("room", {"type": "voiceLevels", "value": 0.8})
        await asyncio.wait_for(sending_levels.wait(), timeout=1)
        hub.set_room("anna", None)
        socket.release.set()
        await asyncio.wait_for(reply, timeout=1)
        await asyncio.wait_for(settled(hub), timeout=2)
        assert socket.messages == [acknowledgement]

    asyncio.run(scenario())


def test_repeated_social_changes_render_one_current_inbox(monkeypatch) -> None:
    async def scenario() -> None:
        hub = SocialHub()
        rendered: list[str] = []

        def render(account: str) -> object:
            rendered.append(account)
            return {"type": "inbox", "account": account}

        hub.start(render)
        socket = Socket()
        connect(hub, "anna", socket)
        loop = asyncio.get_running_loop()
        schedule = loop.call_soon_threadsafe
        calls = 0

        def counted(*args, **kwargs):
            nonlocal calls
            calls += 1
            return schedule(*args, **kwargs)

        with monkeypatch.context() as changes:
            changes.setattr(loop, "call_soon_threadsafe", counted)
            for _ in range(1000):
                hub.changed(("anna",))
        await asyncio.wait_for(settled(hub), timeout=3)
        assert calls <= 1, f"One account accumulated {calls} inbox callbacks"
        assert rendered == ["anna"]
        assert socket.messages == [{"type": "inbox", "account": "anna"}]

    asyncio.run(scenario())


def test_changes_during_an_inbox_render_trigger_one_fresh_snapshot() -> None:
    async def scenario() -> None:
        hub = SocialHub()
        loop = asyncio.get_running_loop()
        entered = asyncio.Event()
        release = Event()
        rendered: list[int] = []
        version = 0

        def render(_account: str) -> object:
            captured = version
            rendered.append(captured)
            if captured == 0:
                loop.call_soon_threadsafe(entered.set)
                assert release.wait(3)
            return {"type": "inbox", "version": captured}

        hub.start(render)
        socket = Socket()
        connect(hub, "anna", socket)
        hub.changed(("anna",))
        await asyncio.wait_for(entered.wait(), timeout=1)
        try:
            for version in range(1, 101):
                hub.changed(("anna",))
                await scheduled_callbacks_finished()
            while_rendering = list(rendered)
        finally:
            release.set()
        await asyncio.wait_for(settled(hub), timeout=3)
        assert while_rendering == [0], "Parallel snapshots raced with an unfinished inbox render"
        assert rendered == [0, 100]
        assert socket.messages[-1] == {"type": "inbox", "version": 100}

    asyncio.run(scenario())


@pytest.mark.parametrize("disconnect", [False, True])
def test_a_new_socket_gets_current_inbox_while_an_old_socket_is_stalled(disconnect) -> None:
    async def scenario() -> None:
        hub = SocialHub()
        version = 0
        hub.start(lambda _account: {"type": "inbox", "version": version})
        old, new = Socket(blocked=True), Socket()
        connect(hub, "anna", old)
        hub.changed(("anna",))
        await asyncio.wait_for(old.entered.wait(), timeout=1)
        try:
            if disconnect:
                hub.disconnect("anna", old)
            connect(hub, "anna", new)
            version = 1
            hub.changed(("anna",))
            await asyncio.wait_for(new.received.wait(), timeout=0.5)
            assert not old.messages
            assert new.messages == [{"type": "inbox", "version": 1}]
        finally:
            old.release.set()
            await asyncio.wait_for(settled(hub), timeout=2)

    asyncio.run(scenario())


@pytest.mark.parametrize("outcome", ["error", "cancel"])
def test_failed_or_cancelled_render_releases_notification_ownership(outcome) -> None:
    async def scenario() -> None:
        hub = SocialHub()
        loop = asyncio.get_running_loop()
        entered, finished = asyncio.Event(), asyncio.Event()
        release = Event()
        first = True

        def render(_account: str) -> object:
            if first:
                try:
                    loop.call_soon_threadsafe(entered.set)
                    if outcome == "error":
                        raise ValueError("Inbox render failed")
                    assert release.wait(3)
                finally:
                    loop.call_soon_threadsafe(finished.set)
            return {"type": "inbox", "ready": True}

        hub.start(render)
        socket = Socket()
        connect(hub, "anna", socket)
        hub._changes["anna"] = True
        worker = asyncio.create_task(hub._push_changes("anna"))
        try:
            await asyncio.wait_for(entered.wait(), timeout=1)
            if outcome == "cancel":
                worker.cancel()
                release.set()
                with pytest.raises(asyncio.CancelledError):
                    await worker
            else:
                with pytest.raises(ValueError, match="Inbox render failed"):
                    await worker
        finally:
            release.set()
            await asyncio.wait_for(finished.wait(), timeout=1)
        assert not hub._changes
        first = False
        hub.changed(("anna",))
        await asyncio.wait_for(socket.received.wait(), timeout=1)
        await asyncio.wait_for(settled(hub), timeout=2)
        assert socket.messages == [{"type": "inbox", "ready": True}]

    asyncio.run(scenario())


def test_idle_worker_cleanup_preserves_a_new_change_from_another_thread(monkeypatch) -> None:
    async def scenario() -> None:
        hub = SocialHub()
        loop = asyncio.get_running_loop()
        next_render = asyncio.Event()
        idle, registered = Event(), Event()
        version = 0

        def render(_account: str) -> object:
            captured = version
            if captured == 1:
                loop.call_soon_threadsafe(next_render.set)
            return {"type": "inbox", "version": captured}

        hub.start(render)
        socket = Socket()
        connect(hub, "anna", socket)
        lock = hub._lock

        class ObserveIdle:
            armed = True

            def __enter__(self):
                lock.acquire()

            def __exit__(self, *_args):
                notify = self.armed and "anna" not in hub._changes
                if notify:
                    self.armed = False
                lock.release()
                if notify:
                    idle.set()
                    assert registered.wait(3)

        monkeypatch.setattr(hub, "_lock", ObserveIdle())

        def change_after_idle():
            nonlocal version
            assert idle.wait(3)
            version = 1
            hub.changed(("anna",))
            registered.set()

        with ThreadPoolExecutor(max_workers=1) as threads:
            changing = threads.submit(change_after_idle)
            hub.changed(("anna",))
            await asyncio.wait_for(next_render.wait(), timeout=3)
            await asyncio.wait_for(settled(hub), timeout=2)
            changing.result(timeout=1)
        assert not hub._changes
        assert socket.messages[-1] == {"type": "inbox", "version": 1}

    asyncio.run(scenario())
