import gc
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor

from backend.projects.content_lock import KeyedLockManager


def test_completed_project_locks_do_not_accumulate(monkeypatch):
    original = threading.RLock
    locks = []

    def tracked_lock():
        lock = original()
        locks.append(weakref.ref(lock))
        return lock

    monkeypatch.setattr(threading, "RLock", tracked_lock)
    manager = KeyedLockManager()
    for index in range(1000):
        with manager.acquire(str(index)):
            pass
    gc.collect()
    assert not any(reference() is not None for reference in locks)


def test_reentrant_project_access_reuses_the_active_lock(monkeypatch):
    original = threading.RLock
    created = 0

    def tracked_lock():
        nonlocal created
        created += 1
        return original()

    monkeypatch.setattr(threading, "RLock", tracked_lock)
    manager = KeyedLockManager()
    with manager.acquire("same"):
        with manager.acquire("same"):
            assert created == 1


def test_pending_owners_remain_mutually_exclusive_while_entries_are_reclaimed():
    manager = KeyedLockManager()
    active = 0
    violations = []
    start = threading.Barrier(4)

    def update():
        nonlocal active
        start.wait(timeout=3)
        for _ in range(100):
            with manager.acquire("same"):
                active += 1
                if active != 1:
                    violations.append(active)
                with manager.acquire("same"):
                    active -= 1

    with ThreadPoolExecutor(max_workers=4) as pool:
        for future in [pool.submit(update) for _ in range(4)]:
            future.result(timeout=5)
    assert not violations and active == 0
