import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event, Lock

import pytest

from backend.infrastructure.in_memory_rooms import InMemoryRoomRepository
from backend.infrastructure.observable_rooms import ObservableRoomRepository
from tests.test_room_snapshot_repository import _candidate


@pytest.fixture
def repository():
    value = ObservableRoomRepository(InMemoryRoomRepository())
    value.save(_candidate())
    return value


def _observed_state(repository, monkeypatch, *, hold=False):
    entered, release, finished = asyncio.Event(), Event(), Event()
    loop, original = asyncio.get_running_loop(), repository._change_state

    def read(room_id, after):
        result = original(room_id, after)
        loop.call_soon_threadsafe(entered.set)
        if hold:
            assert release.wait(3)
        finished.set()
        return result

    monkeypatch.setattr(repository, "_change_state", read)
    return entered, release, finished


@pytest.mark.asyncio
@pytest.mark.parametrize("case", ["newer", "missing", "expired"])
async def test_immediate_room_change_results_preserve_cursor_semantics(repository, case):
    current = repository.version("room")
    room_id = "missing" if case == "missing" else "room"
    after = 0 if case == "newer" else current
    result = await repository.wait_for_change_async(room_id, after, timeout=0)
    assert result == (0 if case == "missing" else current)
    assert not repository._async_waiters


@pytest.mark.asyncio
async def test_timeout_returns_current_cursor_and_unregisters_waiter(repository):
    current = repository.version("room")
    result = await asyncio.wait_for(
        repository.wait_for_change_async("room", current, timeout=0.02), timeout=0.5
    )
    assert result == current
    assert not repository._async_waiters


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["save", "delete"])
async def test_change_between_subscription_and_state_return_is_not_lost(
    repository, monkeypatch, operation
):
    entered, release, finished = _observed_state(repository, monkeypatch, hold=True)
    current = repository.version("room")
    pending = asyncio.create_task(repository.wait_for_change_async("room", current))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        if operation == "delete":
            await asyncio.to_thread(repository.delete, "room")
        else:
            changed = replace(repository.get("room"), library_query="changed")
            await asyncio.to_thread(repository.save, changed)
        expected = repository.version("room")
        release.set()
        assert await asyncio.wait_for(pending, timeout=1) == expected
    finally:
        release.set()
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
    assert finished.is_set()
    assert not repository._async_waiters


@pytest.mark.asyncio
@pytest.mark.parametrize("hold_state", [False, True])
async def test_cancellation_unregisters_before_a_delayed_state_read_finishes(
    repository, monkeypatch, hold_state
):
    entered, release, finished = _observed_state(repository, monkeypatch, hold=hold_state)
    pending = asyncio.create_task(
        repository.wait_for_change_async("room", repository.version("room"))
    )
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(pending, timeout=0.3)
        assert not repository._async_waiters
    finally:
        release.set()
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
    assert await asyncio.to_thread(finished.wait, 1)
    await asyncio.to_thread(repository.delete, "room")
    assert not repository._async_waiters


@pytest.mark.asyncio
async def test_unrelated_and_older_updates_do_not_complete_a_waiter(repository, monkeypatch):
    repository.save(replace(_candidate(), room_id="other"))
    entered, _, _ = _observed_state(repository, monkeypatch)
    pending = asyncio.create_task(repository.wait_for_change_async("room", after=100))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        await asyncio.to_thread(repository.save, replace(_candidate(), room_id="other"))
        await asyncio.to_thread(
            repository.save, replace(_candidate(), library_query="below cursor")
        )
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(pending), timeout=0.03)
        await asyncio.to_thread(repository.delete, "room")
        assert await asyncio.wait_for(pending, timeout=1) == 0
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
    assert not repository._async_waiters


def test_notifications_return_to_each_waiters_own_event_loop(repository, monkeypatch):
    original, ready, guard = repository._change_state, Event(), Lock()
    count = 0

    def observed(room_id, after):
        nonlocal count
        result = original(room_id, after)
        with guard:
            count += 1
            if count == 2:
                ready.set()
        return result

    monkeypatch.setattr(repository, "_change_state", observed)
    current = repository.version("room")
    with ThreadPoolExecutor(max_workers=2) as executor:
        pending = [
            executor.submit(asyncio.run, repository.wait_for_change_async("room", current))
            for _ in range(2)
        ]
        try:
            assert ready.wait(2)
        finally:
            repository.save(replace(_candidate(), library_query="release both loops"))
        assert [item.result(timeout=2) for item in pending] == [repository.version("room")] * 2
    assert not repository._async_waiters
