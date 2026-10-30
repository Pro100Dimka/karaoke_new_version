from __future__ import annotations

import pytest
import json
from dataclasses import replace
from pathlib import Path
from threading import Event, Thread

from backend.ai.domain import AiCapability, AiProviderDescriptor, RequiredModel
from backend.domain_errors import ConflictError, DependencyError
from backend.songs.domain import SongStatus
from backend.processing.domain import JobState
from tests.conftest import app_client, write_wav
from tests.fakes import FakeAiProvider
from tests.helpers import import_song, wait_for_job


pytestmark = [pytest.mark.integration, pytest.mark.e2e]


@pytest.mark.parametrize("extra_supported", [False, True])
def test_extra_recognized_repeat_requires_acoustic_support_without_dropping_quiet_originals(
    extra_supported,
):
    from backend.ai.domain import WordTiming
    from backend.lyrics.discovery import LyricsDiscoveryResult, _with_completed_repeats
    from backend.processing.document_pipeline import _verified_repeats

    baseline = "keep my heart\nkeep my heart\nI am alone"
    found = _with_completed_repeats(
        LyricsDiscoveryResult(baseline, "Sidecar", ()),
        "keep my heart keep my heart keep my heart I am alone",
        Event(),
    )
    assert found.lyrics != baseline
    words = tuple(
        WordTiming(text, i, i + 0.5, 0.5 if i < (9 if extra_supported else 6) else 0.02)
        for i, text in enumerate(found.lyrics.split())
    )
    verified = _verified_repeats(found, words)
    assert verified.lyrics == (found.lyrics if extra_supported else baseline)
    if not extra_supported:
        assert "UnverifiedExtraRepeats" in verified.warnings


@pytest.mark.parametrize("score", [0.02, 0.0])
def test_independently_recognized_repeat_is_not_removed_solely_for_weak_ctc(score):
    from backend.ai.domain import WordTiming
    from backend.lyrics.discovery import LyricsDiscoveryResult
    from backend.processing.document_pipeline import _verified_repeats

    baseline = "keep my heart"
    candidate = "\n".join([baseline] * 2)
    found = LyricsDiscoveryResult(candidate, "Sidecar", (), repeat_baseline=baseline)
    words = tuple(
        WordTiming(
            text,
            i,
            i + 0.5,
            score,
            diagnostics=("RecognizedWord",) + (("ApproximateAlignment",) if not score else ()),
        )
        for i, text in enumerate(candidate.split())
    )

    assert _verified_repeats(found, words).lyrics == candidate


def test_failed_clip_download_keeps_discovered_url_for_retry(tmp_path, monkeypatch) -> None:
    source = tmp_path / "SadSvit - Небо.wav"
    write_wav(source)
    with next_client(tmp_path) as client:
        imported = import_song(client, source)
        container = client.app.state.container
        clip = container.songs.start_processing._preparation._clip
        with container.database.create() as transaction:
            song = transaction.songs.get(imported["songId"])
            song = replace(song, video_url="https://www.youtube.com/watch?v=cPzhNzqt9LA")
            transaction.songs.update(song)
            transaction.commit()
        monkeypatch.setattr(clip._downloader, "download", lambda *args, **kwargs: False)
        assert clip.execute(song).video_url == song.video_url


def test_full_processing_flow_publishes_ready_revision(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)

    with next_client(tmp_path) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
            headers={"Idempotency-Key": "process-once"},
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Succeeded", job
        assert job["overallProgress"] == 1.0
        assert job["report"]["algorithmVersion"] == "pipeline-3"
        assert job["report"]["processingBackend"] == "Local"
        assert job["report"]["songTitle"] == song["title"]
        assert job["report"]["songArtist"] == song["artist"]
        updated = client.get(f"/songs/{song['songId']}").json()
        assert updated["status"] == "Ready"
        assert updated["activeRevision"] == 2
        editor = client.get(f"/songs/{song['songId']}/editor")
        assert editor.status_code == 200, editor.text
        assert editor.json()["document"]["words"][0]["notes"]


def test_reprocessing_an_older_active_revision_preserves_all_saved_revisions(
    tmp_path: Path,
) -> None:
    source = tmp_path / "history.wav"
    write_wav(source)
    with next_client(tmp_path) as client:
        imported = import_song(client, source)
        song_id = imported["songId"]
        path = f"/songs/{song_id}/processing"
        for _ in range(2):
            started = client.post(path, json={"mode": "Fast", "onlineLyrics": False})
            assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        container = client.app.state.container
        storage = container.songs.start_processing._pipeline._publisher._storage
        previous = {
            revision: storage.read_text_artifact(song_id, revision, "lyricsSync")
            for revision in (2, 3)
        }
        with container.database.create() as transaction:
            song = transaction.songs.get(song_id)
            transaction.songs.update(replace(song, active_revision=2))
            transaction.commit()

        started = client.post(path, json={"mode": "Fast", "onlineLyrics": False})
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Succeeded", job
        assert client.get(f"/songs/{song_id}").json()["activeRevision"] == 4
        assert {
            revision: storage.read_text_artifact(song_id, revision, "lyricsSync")
            for revision in previous
        } == previous


def test_clip_download_overlaps_processing_and_preserves_published_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "parallel.wav"
    write_wav(source)
    audio_started, audio_finished, clip_started = Event(), Event(), Event()
    with next_client(tmp_path) as client:
        imported = import_song(client, source)
        container = client.app.state.container
        start = container.songs.start_processing
        with container.database.create() as transaction:
            song = transaction.songs.get(imported["songId"])
            transaction.songs.update(
                replace(song, video_url="https://www.youtube.com/watch?v=test")
            )
            transaction.commit()
        run = start._pipeline.run

        def process(*args, **kwargs):
            audio_started.set()
            assert clip_started.wait(3), "Clip was not started alongside audio processing"
            try:
                return run(*args, **kwargs)
            finally:
                audio_finished.set()

        def download(_url, destination, *, expected_duration, cancel=None):
            clip_started.set()
            assert audio_started.wait(3), "Clip download blocked the start of audio processing"
            assert audio_finished.wait(15), "Clip should be allowed to finish after publication"
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"silent clip")
            return True

        monkeypatch.setattr(start._pipeline, "run", process)
        monkeypatch.setattr(start._preparation._clip._downloader, "download", download)
        started = client.post(
            f"/songs/{song.song_id}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        updated = client.get(f"/songs/{song.song_id}").json()
        assert updated["status"] == "Ready"
        assert updated["activeRevision"] == 2
        assert updated["videoUrl"].endswith(f"/songs/{song.song_id}/clip")
        assert client.get(f"/songs/{song.song_id}/clip").content == b"silent clip"


@pytest.mark.parametrize("after_publication", [False, True])
def test_cancelling_processing_stops_the_parallel_clip_before_releasing_the_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, after_publication: bool
) -> None:
    source = tmp_path / "cancel-clip.wav"
    write_wav(source)
    clip_started, clip_stopped, finished, release, published = (Event() for _ in range(5))
    with next_client(tmp_path) as client:
        imported = import_song(client, source)
        container = client.app.state.container
        start = container.songs.start_processing
        video_url = "https://www.youtube.com/watch?v=HVfb25Jq-_A"
        with container.database.create() as transaction:
            song = transaction.songs.get(imported["songId"])
            transaction.songs.update(replace(song, video_url=video_url))
            transaction.commit()
        cancellation = []
        run = start._pipeline.run

        def process(_song, _options, _providers, context, _execution):
            cancellation.append(context.cancel)
            if after_publication:
                report = run(_song, _options, _providers, context, _execution)
                published.set()
                return report
            assert context.cancel.wait(5)
            raise ConflictError("JobCancelled", "Processing was cancelled")

        def download(_url, _destination, *, expected_duration, cancel=None):
            clip_started.set()
            assert (cancel or release).wait(5)
            if cancel is not None:
                assert cancellation == [cancel]
            clip_stopped.set()
            return False

        finish = start._finish

        def finish_job(*args):
            try:
                finish(*args)
            finally:
                finished.set()

        monkeypatch.setattr(start._pipeline, "run", process)
        monkeypatch.setattr(start._preparation._clip._downloader, "download", download)
        monkeypatch.setattr(start, "_finish", finish_job)
        started = client.post(
            f"/songs/{song.song_id}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        try:
            assert started.status_code == 202, started.text
            assert clip_started.wait(3)
            if after_publication:
                assert published.wait(15)
            job_id = started.json()["jobId"]
            assert client.post(f"/songs/processing/{job_id}/cancel").status_code == 200
            assert finished.wait(2), "Cancellation still waits for the unrelated clip download"
            assert clip_stopped.is_set(), "Job released its resources before the clip stopped"
            assert client.get(f"/jobs/{job_id}").json()["state"] == "Cancelled"
            saved = client.get(f"/songs/{song.song_id}").json()
            assert saved["status"] == "Cancelled"
            assert saved["videoUrl"] == video_url
            if after_publication:
                assert saved["activeRevision"] == 2
                assert client.get(f"/songs/{song.song_id}/editor").status_code == 200
            container.songs.cancel_processing._update_song(song.song_id, JobState.CANCELLING)
            assert client.get(f"/songs/{song.song_id}").json()["status"] == "Cancelled"
        finally:
            release.set()


def test_late_clip_save_preserves_new_song_state_and_manual_metadata(tmp_path: Path) -> None:
    source = tmp_path / "late-clip.wav"
    write_wav(source)
    with next_client(tmp_path) as client:
        imported = import_song(client, source)
        container = client.app.state.container
        with container.database.create() as transaction:
            stale = transaction.songs.get(imported["songId"])
            transaction.songs.update(
                replace(
                    stale,
                    title="Edited while downloading",
                    status=SongStatus.READY,
                    active_revision=3,
                )
            )
            transaction.commit()
        clip = container.songs.start_processing._preparation._clip
        saved = clip._save(stale, "local:clip")
        assert saved.title == "Edited while downloading"
        assert saved.status is SongStatus.READY
        assert saved.active_revision == 3
        assert saved.video_url == "local:clip"


def test_clip_metadata_save_waits_for_project_publication(tmp_path: Path) -> None:
    source = tmp_path / "publication.wav"
    write_wav(source)
    with next_client(tmp_path) as client:
        imported = import_song(client, source)
        container = client.app.state.container
        start = container.songs.start_processing
        with container.database.create() as transaction:
            song = transaction.songs.get(imported["songId"])
        started, finished = Event(), Event()

        def save_clip():
            started.set()
            start._preparation._clip._save(song, "local:clip")
            finished.set()

        worker = Thread(target=save_clip)
        try:
            with start._pipeline._publisher._locks.acquire(song.song_id):
                worker.start()
                assert started.wait(3)
                assert not finished.wait(0.2), "Clip save must share the project publication lock"
        finally:
            worker.join(3)
        assert finished.is_set()


def test_processing_idempotency_returns_same_job(tmp_path: Path) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)

    with next_client(tmp_path) as client:
        song = import_song(client, source)
        path = f"/songs/{song['songId']}/processing"
        headers = {"Idempotency-Key": "processing-key"}
        first = client.post(path, json={"mode": "Fast", "onlineLyrics": False}, headers=headers)
        second = client.post(path, json={"mode": "Fast", "onlineLyrics": False}, headers=headers)

        assert first.status_code == 202, first.text
        assert second.status_code == 202, second.text
        assert first.json()["jobId"] == second.json()["jobId"]
        assert wait_for_job(client, first.json()["jobId"])["state"] == "Succeeded"


def test_missing_ai_models_or_provider_is_rejected_before_heavy_processing(
    client, tmp_path: Path
) -> None:
    source = tmp_path / "song.wav"
    write_wav(source)
    song = import_song(client, source)

    response = client.post(
        f"/songs/{song['songId']}/processing",
        json={"mode": "Fast", "onlineLyrics": False},
    )

    assert response.status_code in {409, 503}
    assert response.json()["code"] in {"AiProviderUnavailable", "MissingRequiredModels"}


def next_client(tmp_path: Path):
    return app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),))


class _CudaOomProvider(FakeAiProvider):
    def pitch(self, vocal, cancel, *, execution):
        del vocal, cancel, execution
        raise DependencyError("CudaOutOfMemory", "simulated CUDA OOM")


def test_cuda_oom_fails_only_job_and_backend_stays_live(tmp_path: Path) -> None:
    source = tmp_path / "cuda-oom.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime-cuda-oom", ai_providers=(_CudaOomProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Failed"
        assert job["error"]["code"] == "CudaOutOfMemory"
        assert client.get("/health/live").status_code == 200
        assert client.get(f"/songs/{song['songId']}").json()["status"] == "Failed"


class _PitchOnlyProvider(FakeAiProvider):
    def __init__(self) -> None:
        super().__init__("pitch-only")
        self._descriptor = AiProviderDescriptor(
            provider_id="pitch-only",
            version="1",
            capabilities=frozenset({AiCapability.PITCH}),
            supported_languages=frozenset({"Auto", "Ukrainian", "Russian", "English"}),
            required_models=(),
            required_resources={"cpuThreads": 1},
        )


def test_melody_reprocess_uses_existing_artifacts_and_only_pitch_provider(tmp_path: Path) -> None:
    root = tmp_path / "runtime-melody"
    source = tmp_path / "melody.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        ready = client.get(f"/songs/{song['songId']}").json()
        previous_revision = ready["activeRevision"]

    with app_client(root, ai_providers=(_PitchOnlyProvider(),)) as client:
        headers = {"Idempotency-Key": "melody-once"}
        started = client.post(f"/songs/{song['songId']}/processing/melody", headers=headers)
        repeated = client.post(f"/songs/{song['songId']}/processing/melody", headers=headers)
        assert started.status_code == 202, started.text
        assert repeated.status_code == 202, repeated.text
        assert repeated.json()["jobId"] == started.json()["jobId"]
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Succeeded", job
        assert job["report"]["algorithmVersion"] == "melody-2"
        stage_names = {item["stage"] for item in job["report"]["stages"]}
        assert "PitchAnalysis" in stage_names
        assert "StemSeparation" not in stage_names
        assert "ForcedAlignment" not in stage_names
        assert "LyricsDiscovery" not in stage_names
        updated = client.get(f"/songs/{song['songId']}").json()
        assert updated["activeRevision"] == previous_revision + 1
        assert updated["status"] == "Ready"


class _CrashingProvider(FakeAiProvider):
    def pitch(self, vocal, cancel, *, execution):
        del execution
        raise RuntimeError("provider bug")


class _ApproximateAlignmentProvider(FakeAiProvider):
    def __init__(self, confidence=0.0, diagnostics=()):
        super().__init__()
        self.confidence = confidence
        self.diagnostics = diagnostics

    def align(self, *args, **kwargs):
        return tuple(
            replace(word, confidence=self.confidence, diagnostics=self.diagnostics)
            for word in super().align(*args, **kwargs)
        )


@pytest.mark.parametrize(
    "confidence,diagnostics,warning",
    [
        (0.0, (), "AlignmentApproximate:wordIndices=0"),
        (
            0.99,
            ("AsrCtcBoundaryDisagreement",),
            "AlignmentDiagnostic:wordIndex=0;AsrCtcBoundaryDisagreement",
        ),
    ],
)
def test_approximate_alignment_is_reported_and_persisted(
    tmp_path: Path, confidence: float, diagnostics: tuple[str, ...], warning: str
) -> None:
    source = tmp_path / "approximate.wav"
    write_wav(source)
    root = tmp_path / "runtime"
    with app_client(
        root, ai_providers=(_ApproximateAlignmentProvider(confidence, diagnostics),)
    ) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert job["report"]["warnings"] == [
            warning,
            "PitchActivityUnavailable:frames=17;unobservedGapsNotBridged",
        ]
        revision = root / "songs" / song["songId"] / "revisions" / "2"
        provenance = json.loads((revision / "manifest.json").read_text(encoding="utf-8"))[
            "provenance"
        ]
        assert provenance["lyricsSource"] == "ASR"
        assert provenance["warnings"] == job["report"]["warnings"]


class _RealignmentProvider(FakeAiProvider):
    def align(self, *args, **kwargs):
        return tuple(
            replace(word, start=0.2, end=0.8, letters=(0.2, 0.4))
            for word in super().align(*args, **kwargs)
        )

    def separate(self, *args, **kwargs):
        raise AssertionError("Existing stems must be reused for lyrics realignment")

    def transcribe(self, *args, **kwargs):
        raise AssertionError("The existing lyric text must be preserved")


@pytest.mark.parametrize("saved", ["catalog", "legacy", "invalid"])
def test_repeated_word_refinement_preserves_phase_hints_and_detected_lyric_language(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    saved: str,
) -> None:
    from backend.lyrics.discovery import LyricsDiscoveryResult
    from backend.lyrics.ports import LyricLineTiming
    from backend.songs.domain import Language

    source = tmp_path / "phase.wav"
    write_wav(source)
    root = tmp_path / "runtime"
    provider, calls = FakeAiProvider(), []
    original = provider.align

    def align(*args, **kwargs):
        calls.append((args[2], tuple(kwargs.get("timing_hints", ()))))
        return original(*args, **kwargs)

    monkeypatch.setattr(provider, "align", align)
    with app_client(root, ai_providers=(provider,)) as client:
        song = import_song(client, source)
        discovery = client.app.state.container.songs.start_processing._pipeline._document._discovery
        monkeypatch.setattr(
            discovery,
            "discover",
            lambda *args, **kwargs: LyricsDiscoveryResult(
                "ла", "catalog", (), (LyricLineTiming(0.2, "ла"),)
            ),
        )
        started = client.post(f"/songs/{song['songId']}/processing", json={"mode": "Fast"})
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        manifest_path = root / "songs" / song["songId"] / "revisions" / "2" / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if saved != "catalog":
            manifest["provenance"]["lyricsTimingHints"] = (
                None
                if saved == "legacy"
                else [{"start": "bad", "text": "ла"}, {"start": -1, "text": "ла"}, {"start": True}]
            )
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        else:
            assert manifest["provenance"].get("lyricsTimingHints") == [{"start": 0.2, "text": "ла"}]
        for _ in range(2):
            started = client.post(f"/songs/{song['songId']}/processing/lyrics")
            assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        expected = LyricLineTiming(0.2 if saved == "catalog" else 0.05, "ла")
        assert calls[1:] == [(Language.RUSSIAN, (expected,))] * 2


class _RemoteTimingProvider(_RealignmentProvider):
    def __init__(self):
        super().__init__("kaggle-p100", required_resources={"remote": True})
        self._descriptor = replace(
            self._descriptor, capabilities=frozenset({AiCapability.ALIGNMENT, AiCapability.PITCH})
        )


@pytest.mark.parametrize("operation", ["melody", "lyrics"])
def test_existing_project_reprocess_routes_kaggle_without_local_models(tmp_path, operation):
    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
    unavailable = FakeAiProvider(
        "unavailable-local", required_models=(RequiredModel("not-installed", "1", "0" * 64),)
    )
    with app_client(root, ai_providers=(unavailable, _RemoteTimingProvider())) as client:
        changed = client.patch(
            "/settings",
            json={
                "processingBackend": "Kaggle",
                "computeMode": "CUDA",
                "kaggleToken": "test-token",
                "selectedPitchProvider": "unavailable-local",
                "selectedAlignmentProvider": "unavailable-local",
            },
        )
        assert changed.status_code == 200, changed.text
        started = client.post(f"/songs/{song['songId']}/processing/{operation}")
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert job["report"]["processingBackend"] == "Kaggle"
        expected = {"pitch": "kaggle-p100"}
        if operation == "lyrics":
            expected["alignment"] = "kaggle-p100"
        assert job["report"]["providers"] == expected
        assert not {item["stage"] for item in job["report"]["stages"]} & {
            "StemSeparation",
            "LyricsDiscovery",
        }


@pytest.mark.parametrize("operation", ["melody", "lyrics"])
def test_existing_project_remote_reprocess_propagates_stale_worker_protocol(
    tmp_path, monkeypatch, operation
):
    import httpx

    import backend.infrastructure.kaggle_ai_provider as remote_module
    from backend.infrastructure.kaggle_ai_provider import KaggleAiProvider
    from backend.settings.domain import BackendSettings, ProcessingBackend

    root = tmp_path / "runtime"
    source = tmp_path / "song.wav"
    write_wav(source)
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
    probes = []

    class StaleWorker:
        def __init__(self, *_args, **_kwargs):
            pass

        def predict(self, *, api_name):
            probes.append(api_name)
            return {"protocolVersion": 4}

    monkeypatch.setattr(remote_module, "Client", StaleWorker)
    remote = KaggleAiProvider(
        lambda: BackendSettings(
            2,
            processing_backend=ProcessingBackend.KAGGLE,
            kaggle_url="https://stub.gradio.live",
            kaggle_token="test-token",
        ),
        discovery_transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )
    monkeypatch.setattr(remote, "_handle_file", str)
    with app_client(root, ai_providers=(remote,)) as client:
        assert (
            client.patch(
                "/settings", json={"processingBackend": "Kaggle", "kaggleToken": "test-token"}
            ).status_code
            == 200
        )
        started = client.post(f"/songs/{song['songId']}/processing/{operation}")
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Failed", job
        assert job["error"]["code"] == "KaggleProtocolMismatch"
        assert job["report"]["processingBackend"] == "Kaggle"
        assert probes == ["/health"]


def test_existing_project_can_realign_words_without_original_and_preserve_rollback(
    tmp_path: Path,
) -> None:
    source = tmp_path / "realign.wav"
    write_wav(source)
    root = tmp_path / "runtime"
    with app_client(tmp_path / "source-runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        before = client.get(f"/songs/{song['songId']}/editor").json()
        exported = client.post(f"/packages/export/{song['songId']}")
        export_job = wait_for_job(client, exported.json()["jobId"])
        assert export_job["state"] == "Succeeded", export_job
    previous = root / "songs" / song["songId"] / "revisions" / str(before["revision"])
    with app_client(root, ai_providers=(_RealignmentProvider(),)) as client:
        imported = client.post("/packages/import", json={"path": export_job["report"]["path"]})
        assert wait_for_job(client, imported.json()["jobId"])["state"] == "Succeeded"
        original_bytes = (previous / "lyricsSync.json").read_bytes()
        path = f"/songs/{song['songId']}/processing/lyrics"
        headers = {"Idempotency-Key": "realign-once"}
        started = client.post(path, headers=headers)
        assert started.status_code == 202, started.text
        assert client.post(path, headers=headers).json()["jobId"] == started.json()["jobId"]
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Succeeded", job
        assert job["report"]["algorithmVersion"] == "lyrics-3"
        assert job["report"]["timingOperation"] == "lyrics"
        stages = {item["stage"] for item in job["report"]["stages"]}
        assert "ForcedAlignment" in stages
        assert not stages & {"StemSeparation", "LyricsDiscovery"}
        after = client.get(f"/songs/{song['songId']}/editor").json()
        assert after["revision"] == before["revision"] + 1
        word = after["document"]["words"][0]
        assert (word["start"], word["end"], word["letters"]) == (0.2, 0.8, [0.2, 0.4])
        assert (previous / "lyricsSync.json").read_bytes() == original_bytes
    with app_client(root, ai_providers=(FakeAiProvider(),)) as client:
        assert client.get(f"/songs/{song['songId']}/editor").json() == after
        restored = client.put(
            f"/songs/{song['songId']}/editor",
            json={"expectedRevision": after["revision"], "document": before["document"]},
        )
        assert restored.status_code == 200, restored.text
        assert (
            client.get(f"/songs/{song['songId']}/editor").json()["document"] == before["document"]
        )


@pytest.mark.parametrize("operation", ["processing", "processing/melody", "processing/lyrics"])
def test_generated_reprocessing_does_not_overwrite_manual_edits(
    tmp_path: Path, operation: str
) -> None:
    source = tmp_path / "manual.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime", ai_providers=(FakeAiProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert wait_for_job(client, started.json()["jobId"])["state"] == "Succeeded"
        editor_path = f"/songs/{song['songId']}/editor"
        before = client.get(editor_path).json()
        before["document"]["words"][0]["notes"][0]["note"] = 70
        saved = client.put(
            editor_path,
            json={"expectedRevision": before["revision"], "document": before["document"]},
        )
        assert saved.status_code == 200, saved.text
        edited = client.get(editor_path).json()
        started = client.post(
            f"/songs/{song['songId']}/{operation}", json={"mode": "Fast", "onlineLyrics": False}
        )
        assert started.status_code == 202, started.text
        job = wait_for_job(client, started.json()["jobId"])
        assert job["state"] == "Failed", job
        assert job["error"]["code"] == "ManualLyricsConflict"
        assert client.get(editor_path).json() == edited
        assert client.get(f"/songs/{song['songId']}").json()["status"] == "Ready"


def test_unexpected_provider_crash_does_not_leave_the_song_processing(tmp_path: Path) -> None:
    source = tmp_path / "crash.wav"
    write_wav(source)
    with app_client(tmp_path / "runtime-crash", ai_providers=(_CrashingProvider(),)) as client:
        song = import_song(client, source)
        started = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        job = wait_for_job(client, started.json()["jobId"])

        assert job["state"] == "Failed"
        assert client.get(f"/songs/{song['songId']}").json()["status"] == "Failed"
        again = client.post(
            f"/songs/{song['songId']}/processing",
            json={"mode": "Fast", "onlineLyrics": False},
        )
        assert again.status_code == 202, again.text
