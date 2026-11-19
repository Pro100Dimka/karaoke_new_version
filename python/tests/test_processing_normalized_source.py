from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from backend.infrastructure.job_executor import ThreadConcurrentRunner
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy
from backend.processing.algorithms import MusicMetadata
from backend.processing.audio_pipeline import PrepareProcessingAudio
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.processing.document_pipeline import BuildProcessingDocument
from backend.processing.domain import ProcessingMode, ProcessingOptions
from backend.processing.orchestrator import PipelineOrchestrator
from backend.processing.preflight import ProcessingProviders
from backend.processing.stage_runner import StageRunner
from backend.songs.domain import Language, Song, SongStatus, SourceState
from tests.fakes import FakeAiProvider


class _SequentialProvider(FakeAiProvider):
    def __init__(self):
        super().__init__()
        self.requests = []
        self.stream_calls = 0
        self.separation_input = None
        self.first_request = threading.Event()
        self.expect_stream = False

    def separate(self, audio, *args, **kwargs):
        self.separation_input = audio
        return super().separate(audio, *args, **kwargs)

    def transcribe(self, audio, language, cancel, *, execution, start_seconds=0.0):
        self.requests.append((audio, start_seconds))
        return "we sing"


class _BatchProvider(_SequentialProvider):
    def transcribe_many(self, requests, language, cancel, *, execution):
        self.requests.extend(requests)
        return ("we sing",) * len(requests)

    def transcribe(self, *args, **kwargs):
        raise AssertionError("Batch results must be reused for the ending")


class _StreamingProvider(_SequentialProvider):
    def separate(self, audio, *args, **kwargs):
        if self.expect_stream:
            assert self.first_request.wait(2), "Original recognition must overlap separation"
        return super().separate(audio, *args, **kwargs)

    def transcribe_stream(self, requests, count, language, cancel, *, execution):
        self.stream_calls += 1
        for request in requests(threading.Event()):
            self.requests.append(request)
            self.first_request.set()
        assert len(self.requests) == count
        return ("we sing",) * count


def _song(source: Path | None) -> Song:
    now = datetime.now(UTC)
    return Song(
        "song",
        "Title",
        "Artist",
        "source-hash",
        SourceState.MANAGED,
        source,
        SongStatus.IMPORTED,
        1,
        1,
        now,
        now,
        duration=73,
        language=Language.ENGLISH,
    )


def _discover_prepared(tmp_path, provider, cache_hit, sidecar):
    provider.expect_stream = sidecar
    source = tmp_path / "original.mp3"
    source.write_bytes(b"original compressed media")
    if sidecar:
        source.with_suffix(".txt").write_text("we sing", encoding="utf-8")
    normalized = tmp_path / "cache" / "artifact.wav"
    normalized.parent.mkdir()
    normalized.write_bytes(b"normalized PCM")
    normalize = Mock(run=Mock(return_value=(normalized, cache_hit)))
    stages = StageRunner(Mock(seconds=Mock(return_value=0.0)))
    concurrency = ThreadConcurrentRunner()
    audio = PrepareProcessingAudio(
        normalize, Mock(analyze=Mock(return_value=MusicMetadata(None, None))), Mock(), stages
    )
    document = BuildProcessingDocument(
        LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy()), stages, concurrency
    )
    pipeline = PipelineOrchestrator(
        audio, document, Mock(), Mock(), Mock(), stages, Mock(), concurrency
    )
    song = _song(source)
    context = Mock(cancel=threading.Event())
    providers = ProcessingProviders(provider, provider, provider, provider)
    options = ProcessingOptions(ProcessingMode.AUTO, online_lyrics=False)
    execution = ExecutionContext(ComputeDevice.CPU, 4, parallel_cpu_fraction=0.5)
    reports = []
    prepared, lyrics = pipeline._prepare(
        song, options, providers, tmp_path / "work", context, reports, execution
    )
    found = document._discover(
        song, prepared, providers, options, context, reports, execution, lyrics
    )
    return SimpleNamespace(
        song=song, prepared=prepared, found=found, normalized=normalized, normalize=normalize
    )


@pytest.mark.parametrize("provider_type", [_SequentialProvider, _BatchProvider, _StreamingProvider])
@pytest.mark.parametrize("cache_hit", [False, True])
@pytest.mark.parametrize("sidecar", [False, True])
def test_original_asr_uses_the_same_normalized_pcm_as_separation(
    tmp_path, provider_type, cache_hit, sidecar
):
    provider = provider_type()
    case = _discover_prepared(tmp_path, provider, cache_hit, sidecar)
    vocal, normalized = case.prepared.reference_vocal, case.normalized
    full = [(vocal, 0.0), (normalized, 0.0)]
    ending = [(vocal, 25.0), (normalized, 25.0)] if sidecar else []
    streaming = provider_type is _StreamingProvider and sidecar
    expected = [full[1], full[0], *ending] if streaming else [*full, *ending]
    assert provider.requests == expected
    assert provider.stream_calls == int(streaming)
    assert provider.separation_input == normalized == case.prepared.normalized_original
    assert case.prepared.normalized_cache_hit is cache_hit
    assert case.found.source == ("LocalSidecar" if sidecar else "ASR")
    assert case.found.lyrics == "we sing"
    assert case.song.source_path == tmp_path / "original.mp3"
    assert case.song.source_path.read_bytes() == b"original compressed media"
    assert case.song.source_identity == "source-hash"
    assert case.normalize.run.call_args.args[0] is case.song


@pytest.mark.parametrize(
    ("source_kind", "original_kind", "expected_original"),
    [
        ("absent", "default", None),
        ("missing", "default", None),
        ("present", "default", "original"),
        ("present", "vocal", None),
        ("present", "missing", None),
        ("missing", "normalized", "normalized"),
        ("absent", "normalized", "normalized"),
    ],
)
def test_discovery_normalized_source_is_explicit_and_does_not_duplicate_or_fall_back(
    tmp_path, source_kind, original_kind, expected_original
):
    paths = {
        name: tmp_path / f"{name}.wav" for name in ("vocal", "original", "normalized", "missing")
    }
    for name in ("vocal", "normalized"):
        paths[name].touch()
    if source_kind == "present":
        paths["original"].touch()
    song = _song(None if source_kind == "absent" else paths["original"])
    provider = _SequentialProvider()
    discovery = LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy())
    kwargs = {} if original_kind == "default" else {"original_audio": paths[original_kind]}
    found = discovery.discover(
        song,
        paths["vocal"],
        provider,
        threading.Event(),
        online_enabled=False,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        **kwargs,
    )
    expected = [(paths["vocal"], 0.0)]
    if expected_original is not None:
        expected.append((paths[expected_original], 0.0))
    assert provider.requests == expected
    assert found.lyrics == "we sing"
