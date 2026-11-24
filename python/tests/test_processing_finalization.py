from __future__ import annotations

from threading import Event

import pytest

from backend.domain_errors import DependencyError
from backend.processing.domain import ProcessingReport
from backend.processing.resource_scheduler import ResourceLease
from backend.projects.operations import SongOperation
from backend.songs.domain import SongStatus
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


@pytest.mark.parametrize("outcome", ["succeeded", "failed", "cancelled"])
def test_processing_settles_only_after_releasing_its_resources(tmp_path, monkeypatch, outcome):
    source = tmp_path / "source.wav"
    write_wav(source, seconds=0.125)
    running, releasing, allow_release = (Event() for _ in range(3))
    released = []
    finish_calls = []
    terminal_events = []
    release = ResourceLease.release

    def held_release(lease):
        releasing.set()
        assert allow_release.wait(5), "The test did not release the resource cleanup"
        release(lease)
        released.append(lease)

    monkeypatch.setattr(ResourceLease, "release", held_release)
    with app_client(
        tmp_path / "runtime",
        ai_providers=(FakeAiProvider(required_resources={"cpuThreads": 1, "ramBytes": 4096}),),
    ) as client:
        song_id = import_song(client, source)["songId"]
        container = client.app.state.container
        start = container.songs.start_processing
        resources = start._resources
        finish = start._finish
        publish = container.events.publish

        def observed_finish(identity, admission):
            finish_calls.append(identity)
            finish(identity, admission)

        def observed_publish(name, payload):
            if (
                name == "job.changed"
                and payload.get("entityId") == song_id
                and payload.get("state") in {"Succeeded", "Failed", "Cancelled"}
            ):
                terminal_events.append(
                    (
                        payload["state"],
                        resources._reserved_cpu,
                        resources._reserved_ram,
                        resources._reserved_vram,
                        start._operations.active(song_id),
                    )
                )
                # An immediate retry can claim the song after completion is published.
                # The old job's finalizer must not release that new owner's reservation.
                start._operations.claim(song_id, SongOperation.PROCESSING)
            publish(name, payload)

        def process(song, _options, _providers, context, _execution):
            running.set()
            if outcome == "cancelled":
                assert context.cancel.wait(5), "The test did not request cancellation"
                context.ensure_not_cancelled()
            if outcome == "failed":
                raise DependencyError("RecognitionFailed", "Recognition failed")
            start._persistence.set_status(song.song_id, SongStatus.READY)
            return ProcessingReport(song.song_id, song.active_revision, (), {}, False, (), "test")

        monkeypatch.setattr(start, "_finish", observed_finish)
        monkeypatch.setattr(start._pipeline, "run", process)
        monkeypatch.setattr(container.events, "publish", observed_publish)
        response = client.post(
            f"/songs/{song_id}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert response.status_code == 202, response.text
        identity = response.json()["jobId"]
        try:
            assert running.wait(3)
            if outcome == "cancelled":
                assert client.post(f"/jobs/{identity}/cancel").status_code == 200
            assert releasing.wait(3)
            assert resources._reserved_cpu > 0 and resources._reserved_ram == 4096
            current = client.get(f"/jobs/{identity}").json()
            expected = "Cancelling" if outcome == "cancelled" else "Running"
            assert current["state"] == expected, current
            assert not terminal_events, "Completion was published while resources were still owned"
        finally:
            allow_release.set()
        completed = wait_for_job(client, identity)
        container.executor.shutdown()
        assert completed["state"] == outcome.capitalize()
        if outcome == "failed":
            assert completed["error"]["code"] == "RecognitionFailed"
        assert terminal_events == [(outcome.capitalize(), 0, 0, 0, None)]
        assert len(released) == 1 and finish_calls == [song_id]
        assert start._operations.active(song_id) is SongOperation.PROCESSING
        start._operations.release(song_id, SongOperation.PROCESSING)


def test_cancellation_before_work_still_releases_admitted_resources_once(tmp_path, monkeypatch):
    source = tmp_path / "source.wav"
    write_wav(source, seconds=0.125)
    submitted = []
    releases = []
    release = ResourceLease.release

    def observed_release(lease):
        releases.append(lease)
        release(lease)

    monkeypatch.setattr(ResourceLease, "release", observed_release)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song_id = import_song(client, source)["songId"]
        container = client.app.state.container
        start = container.songs.start_processing
        monkeypatch.setattr(
            container.executor,
            "submit",
            lambda identity, execute, *, admit: submitted.append((identity, execute, admit)),
        )
        response = client.post(
            f"/songs/{song_id}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert response.status_code == 202, response.text
        identity, execute, admit = submitted[0]
        cancel = Event()
        assert admit(cancel)
        assert start._resources._reserved_cpu > 0
        assert start._operations.active(song_id) is SongOperation.PROCESSING
        container.system.jobs.cancel(identity)
        cancel.set()
        execute(cancel)
        assert client.get(f"/jobs/{identity}").json()["state"] == "Cancelled"
        assert len(releases) == 1
        assert start._resources._reserved_cpu == 0
        assert start._operations.active(song_id) is None


def test_failed_finalization_releases_resources_once_and_cannot_report_success(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.wav"
    write_wav(source, seconds=0.125)
    finalized = []
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song_id = import_song(client, source)["songId"]
        container = client.app.state.container
        start = container.songs.start_processing
        finish = start._finish

        def failed_finish(identity, admission):
            finalized.append(identity)
            finish(identity, admission)
            raise DependencyError("FinalizationFailed", "Finalization could not finish")

        def process(song, _options, _providers, _context, _execution):
            start._persistence.set_status(song.song_id, SongStatus.READY)
            return ProcessingReport(song.song_id, song.active_revision, (), {}, False, (), "test")

        monkeypatch.setattr(start, "_finish", failed_finish)
        monkeypatch.setattr(start._pipeline, "run", process)
        response = client.post(
            f"/songs/{song_id}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert response.status_code == 202, response.text
        completed = wait_for_job(client, response.json()["jobId"])
        container.executor.shutdown()
        assert completed["state"] == "Failed"
        assert completed["error"]["code"] == "FinalizationFailed"
        assert finalized == [song_id]
        resources = start._resources
        assert (resources._reserved_cpu, resources._reserved_ram, resources._reserved_vram) == (
            0,
            0,
            0,
        )
        assert start._operations.active(song_id) is None
