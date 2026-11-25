import asyncio
import sys
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Lock
from types import SimpleNamespace
from unittest.mock import Mock

import anyio
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.errors import domain_error_response
from backend.api.song_routes import router
from backend.domain_errors import DomainError
from backend.infrastructure.ffmpeg_media import FfmpegMediaInspector
from backend.infrastructure.process_runner import ProcessResult, ProcessRunner
from backend.songs.queries import GetSongWaveform


def _app(tmp_path, run):
    for index in (1, 2, 3):
        (tmp_path / f"song-{index}.wav").touch()
    media = FfmpegMediaInspector(SimpleNamespace(run=run))
    songs = SimpleNamespace(
        execute=lambda song_id: SimpleNamespace(source_path=tmp_path / f"{song_id}.wav")
    )
    app = FastAPI()
    app.include_router(router)
    app.add_exception_handler(DomainError, domain_error_response)
    app.state.container = SimpleNamespace(
        songs=SimpleNamespace(get_waveform=GetSongWaveform(songs, media))
    )
    return app, media


def _request(app, index):
    incoming = asyncio.Queue()
    incoming.put_nowait({"type": "http.request", "body": b"", "more_body": False})
    messages = []

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": f"/songs/song-{index}/waveform",
        "query_string": b"bins=16",
        "headers": [],
    }
    return asyncio.create_task(app(scope, incoming.get, send)), incoming, messages


def _status(messages):
    return next(item["status"] for item in messages if item["type"] == "http.response.start")


def _peaks():
    return ProcessResult(0, np.ones(100, dtype="<f4").tobytes(), b"")


@pytest.mark.asyncio
@pytest.mark.parametrize("disconnect_queued", [False, True])
async def test_abandoned_waveforms_release_admission_for_the_current_song(
    tmp_path, disconnect_queued
):
    entered, cleanup = Event(), Event()
    guard = Lock()
    invoked, cancelled = [], []

    def run(command, **kwargs):
        source = Path(command[command.index("-i") + 1]).stem
        with guard:
            invoked.append(source)
            if len(invoked) == 2:
                entered.set()
        if source != "song-3":
            cancel = kwargs.get("cancel")
            assert (cancel or cleanup).wait(5), "Abandoned waveform decoding was not stopped"
            if cancel is not None and cancel.is_set():
                with guard:
                    cancelled.append(source)
                raise DomainError("ProcessCancelled", "External process was cancelled", 499)
        return _peaks()

    app, _ = _app(tmp_path, run)
    requests = [_request(app, index) for index in (1, 2)]
    responded = False
    try:
        assert await anyio.to_thread.run_sync(entered.wait, 2)
        latest = _request(app, 3)
        requests.append(latest)
        for _, incoming, _ in requests[-1:] if disconnect_queued else requests[:2]:
            incoming.put_nowait({"type": "http.disconnect"})
        try:
            await asyncio.wait_for(asyncio.shield(latest[0]), 0.5)
            responded = True
        except TimeoutError:
            pass
    finally:
        cleanup.set()
        for _, incoming, _ in requests:
            incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(*(item[0] for item in requests)), 6)
    assert responded, "Disconnected waveform requests retained the decode admission slots"
    if disconnect_queued:
        assert _status(latest[2]) == 499
        assert sorted(invoked) == ["song-1", "song-2"]
    else:
        assert _status(latest[2]) == 200
        assert sorted(cancelled) == ["song-1", "song-2"]


@pytest.mark.asyncio
async def test_cancelled_same_file_waiter_releases_its_slot_without_stopping_the_owner(
    tmp_path, monkeypatch
):
    decoding, waiting, cleanup = Event(), Event(), Event()
    signals = []

    def run(command, **kwargs):
        if Path(command[command.index("-i") + 1]).stem == "song-1":
            signals.append(kwargs.get("cancel"))
            decoding.set()
            assert cleanup.wait(5)
        return _peaks()

    app, media = _app(tmp_path, run)
    acquire = media._waveform_locks.acquire
    attempts = 0
    guard = Lock()

    @contextmanager
    def observed(key, **kwargs):
        nonlocal attempts
        with guard:
            attempts += 1
            if attempts == 2:
                waiting.set()
        with acquire(key, **kwargs):
            yield

    monkeypatch.setattr(media._waveform_locks, "acquire", observed)
    requests = [_request(app, 1)]
    responded = False
    try:
        assert await anyio.to_thread.run_sync(decoding.wait, 2)
        waiter = _request(app, 1)
        requests.append(waiter)
        assert await anyio.to_thread.run_sync(waiting.wait, 2)
        latest = _request(app, 3)
        requests.append(latest)
        waiter[1].put_nowait({"type": "http.disconnect"})
        try:
            await asyncio.wait_for(asyncio.shield(latest[0]), 0.5)
            responded = True
        except TimeoutError:
            pass
        assert len(signals) == 1
        assert signals[0] is None or not signals[0].is_set()
    finally:
        cleanup.set()
        for _, incoming, _ in requests:
            incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(*(item[0] for item in requests)), 6)
    assert responded, "An abandoned same-file cache waiter retained a waveform admission slot"
    assert _status(waiter[2]) == 499
    assert _status(latest[2]) == 200


def test_waveform_cache_keeps_successful_results_across_request_cancellation_tokens(tmp_path):
    source = tmp_path / "song.wav"
    source.write_bytes(b"original")
    runner = Mock(run=Mock(return_value=_peaks()))
    media = FfmpegMediaInspector(runner)
    first = media.waveform_peaks(source, 16, cancel=Event())
    first[0] = 0
    assert media.waveform_peaks(source, 16, cancel=Event()) == [1.0] * 16
    assert runner.run.call_count == 1
    cancelled = Event()
    cancelled.set()
    with pytest.raises(DomainError) as error:
        media.waveform_peaks(source, 16, cancel=cancelled)
    assert error.value.code == "ProcessCancelled"
    assert runner.run.call_count == 1
    source.write_bytes(b"changed-source")
    assert media.waveform_peaks(source, 16) == [1.0] * 16
    assert media.waveform_peaks(source, 32) == [1.0] * 32
    assert runner.run.call_count == 3


def test_waveform_cache_retains_256_most_recent_completed_requests(tmp_path):
    source = tmp_path / "song.wav"
    source.touch()
    runner = Mock(run=Mock(return_value=_peaks()))
    media = FfmpegMediaInspector(runner)
    for bins in range(16, 273):
        media.waveform_peaks(source, bins)
    assert runner.run.call_count == 257
    media.waveform_peaks(source, 272)
    assert runner.run.call_count == 257
    media.waveform_peaks(source, 16)
    assert runner.run.call_count == 258


@pytest.mark.asyncio
async def test_cancelled_decode_leaves_same_song_request_free_to_retry_and_cache(tmp_path):
    entered = Event()
    signals = []

    def run(_command, **kwargs):
        cancel = kwargs["cancel"]
        signals.append(cancel)
        if len(signals) == 1:
            entered.set()
            assert cancel.wait(5)
            raise DomainError("ProcessCancelled", "External process was cancelled", 499)
        return _peaks()

    app, _ = _app(tmp_path, run)
    requests = [_request(app, 1)]
    try:
        assert await anyio.to_thread.run_sync(entered.wait, 2)
        sibling = _request(app, 1)
        requests.append(sibling)
        requests[0][1].put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(*(item[0] for item in requests)), 1)
        assert _status(requests[0][2]) == 499
        assert _status(sibling[2]) == 200
        cached = _request(app, 1)
        requests.append(cached)
        await asyncio.wait_for(cached[0], 1)
        assert _status(cached[2]) == 200
        assert len(signals) == 2, "Cancelled work was cached or successful work was decoded again"
    finally:
        for signal in signals:
            signal.set()
        for _, incoming, _ in requests:
            incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(*(item[0] for item in requests)), 6)


@pytest.mark.asyncio
async def test_parent_cancellation_stops_the_active_waveform_decoder(tmp_path):
    entered, stopped = Event(), Event()
    signals = []

    def run(_command, **kwargs):
        cancel = kwargs["cancel"]
        signals.append(cancel)
        entered.set()
        assert cancel.wait(5)
        stopped.set()
        raise DomainError("ProcessCancelled", "External process was cancelled", 499)

    app, _ = _app(tmp_path, run)
    parent = anyio.CancelScope()

    async def cancellable_app(scope, receive, send):
        with parent:
            await app(scope, receive, send)

    request, incoming, _ = _request(cancellable_app, 1)
    try:
        assert await anyio.to_thread.run_sync(entered.wait, 2)
        parent.cancel()
        assert await anyio.to_thread.run_sync(stopped.wait, 1)
        await asyncio.wait_for(asyncio.shield(request), 1)
    finally:
        for signal in signals:
            signal.set()
        incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(request, return_exceptions=True), 6)


@pytest.mark.parametrize("song,code,status", [(1, "InvalidMedia", 400), (4, "SourceMissing", 404)])
def test_waveform_failure_keeps_its_api_error(tmp_path, song, code, status):
    app, _ = _app(tmp_path, lambda *_args, **_kwargs: ProcessResult(1, b"", b"bad audio"))
    with TestClient(app) as client:
        response = client.get(f"/songs/song-{song}/waveform")
    assert response.status_code == status
    assert response.json()["code"] == code


@pytest.mark.asyncio
async def test_http_disconnect_reaps_an_owned_waveform_decoder_process(tmp_path, monkeypatch):
    started = Event()
    processes = []
    runner = ProcessRunner()
    original_start = runner._start

    def controlled_decoder(_command, cwd, environment, suspended=False):
        process = original_start(
            [sys.executable, "-c", "import threading; threading.Event().wait(30)"],
            cwd,
            environment,
            suspended,
        )
        processes.append(process)
        started.set()
        return process

    monkeypatch.setattr(runner, "_start", controlled_decoder)
    app, _ = _app(tmp_path, runner.run)
    request, incoming, messages = _request(app, 1)
    try:
        assert await anyio.to_thread.run_sync(started.wait, 2)
        incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.shield(request), 2)
        assert _status(messages) == 499
        assert len(processes) == 1 and processes[0].poll() is not None
        assert all(
            stream.closed
            for stream in (processes[0].stdin, processes[0].stdout, processes[0].stderr)
        )
    finally:
        incoming.put_nowait({"type": "http.disconnect"})
        await asyncio.wait_for(asyncio.gather(request, return_exceptions=True), 4)
