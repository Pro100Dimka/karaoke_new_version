import queue
import threading
import pytest

from backend.infrastructure.event_stream import EventStream
from tests.fakes import FakeClock


@pytest.mark.parametrize("capacity", [0, -1])
def test_event_subscribers_cannot_have_unbounded_capacity(capacity):
    with pytest.raises(ValueError):
        EventStream(FakeClock(), subscriber_capacity=capacity)


def test_consumer_drain_during_overflow_does_not_lose_latest_event(monkeypatch):
    events = EventStream(FakeClock(), subscriber_capacity=1)
    with events.subscribe() as subscriber:
        events.publish("old", {})
        original_get = subscriber.get_nowait

        def consumer_was_faster():
            original_get()
            subscriber.task_done()
            raise queue.Empty

        monkeypatch.setattr(subscriber, "get_nowait", consumer_was_faster)
        events.publish("latest", {})
        assert original_get().event_type == "latest"


def test_concurrent_overflow_publishers_do_not_raise_or_lose_latest_event(monkeypatch):
    events = EventStream(FakeClock(), subscriber_capacity=1)
    paused, resume, second_started = threading.Event(), threading.Event(), threading.Event()
    errors = []
    with events.subscribe() as subscriber:
        events.publish("old", {})
        original_get = subscriber.get_nowait

        def pause_after_eviction():
            item = original_get()
            if not paused.is_set():
                paused.set()
                assert resume.wait(2)
            return item

        monkeypatch.setattr(subscriber, "get_nowait", pause_after_eviction)

        def publish(name):
            try:
                if name == "second":
                    second_started.set()
                events.publish(name, {})
            except Exception as error:
                errors.append(error)

        first = threading.Thread(target=publish, args=("first",))
        second = threading.Thread(target=publish, args=("second",))
        first.start()
        try:
            assert paused.wait(2)
            second.start()
            assert second_started.wait(2)
            second.join(timeout=0.1)
        finally:
            resume.set()
            first.join(timeout=2)
            if second.ident is not None:
                second.join(timeout=2)
        assert not first.is_alive() and not second.is_alive()
        assert not errors
        assert original_get().event_type == "second"
