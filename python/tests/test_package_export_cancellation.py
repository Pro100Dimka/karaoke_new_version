from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest

from backend.infrastructure import zip_archive
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import wait_for_job
from tests.test_packages_e2e import make_ready_and_export


@pytest.mark.parametrize(
    "cancel_at", ["snapshot", "archive", "validation", "replace-existing", "after-publication"]
)
def test_package_export_cancellation_respects_archive_publication(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cancel_at: str
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    runtime = tmp_path / "runtime"
    with app_client(runtime, ai_providers=(FakeAiProvider(),)) as client:
        song, output = make_ready_and_export(client, source)
        previous_export = output.read_bytes()
        if cancel_at == "replace-existing":
            changed = client.patch(f"/songs/{song['songId']}", json={"title": "New export title"})
            assert changed.status_code == 200, changed.text
        else:
            output.unlink()
        exporter = client.app.state.container.packages.start_export._export
        entered, release = threading.Event(), threading.Event()

        def pause() -> None:
            entered.set()
            assert release.wait(10), "Cancellation request did not finish"

        if cancel_at == "snapshot":
            snapshot = exporter._projects.snapshot_revision

            def blocked_snapshot(*args, **kwargs):
                result = snapshot(*args, **kwargs)
                pause()
                return result

            monkeypatch.setattr(exporter._projects, "snapshot_revision", blocked_snapshot)
        elif cancel_at in {"validation", "replace-existing"}:
            validate = zip_archive._validate_built_archive

            def blocked_validation(path):
                validate(path)
                pause()

            monkeypatch.setattr(zip_archive, "_validate_built_archive", blocked_validation)
        else:
            build = exporter._archive.build

            def blocked_build(destination, files, texts, progress=None):
                def checkpoint(fraction: float) -> None:
                    if not entered.is_set():
                        pause()
                    if progress is not None:
                        progress(fraction)

                build(
                    destination,
                    files,
                    texts,
                    progress=checkpoint if cancel_at == "archive" else progress,
                )
                if cancel_at == "after-publication":
                    pause()

            monkeypatch.setattr(exporter._archive, "build", blocked_build)

        started = client.post(f"/packages/export/{song['songId']}")
        assert started.status_code == 202, started.text
        try:
            assert entered.wait(10), "Export did not reach the cancellation checkpoint"
            cancelled = client.post(f"/jobs/{started.json()['jobId']}/cancel")
            assert cancelled.status_code == 200, cancelled.text
        finally:
            release.set()
        result = wait_for_job(client, started.json()["jobId"])
        published = cancel_at == "after-publication"
        assert result["state"] == ("Succeeded" if published else "Cancelled"), result
        assert output.exists() is (published or cancel_at == "replace-existing")
        if cancel_at == "replace-existing":
            assert output.read_bytes() == previous_export
        with sqlite3.connect(runtime / "app.db") as database:
            count = database.execute(
                "SELECT count(*) FROM history_events WHERE event_type='PackageExported'"
            ).fetchone()[0]
        assert count == (2 if published else 1)
        assert not list(output.parent.glob(".*.tmp"))
