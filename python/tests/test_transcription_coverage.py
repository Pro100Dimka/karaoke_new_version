from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path

import pytest
import numpy as np

from backend.ai_worker import speech
from backend.ai_worker import speech_observations
from backend.infrastructure.sidecar_lyrics import LocalSidecarLyricsReader
from backend.lyrics.discovery import LyricsDiscovery, LyricsMatchPolicy, PreparedLyrics
from backend.processing.compute_policy import ComputeDevice, ExecutionContext
from backend.songs.domain import Song, SongStatus, SourceState
from tests.fakes import FakeAiProvider


@pytest.mark.parametrize("spoken", [False, True])
@pytest.mark.parametrize(
    "credit", ["Субтитры создавал Автор", "Субтитри зробив Автор", "Subtitles by Author"]
)
def test_subtitle_credits_over_music_need_speech_evidence(monkeypatch, credit, spoken):
    probability = np.full(94, 0.9 if spoken else 0.01, dtype=np.float32)
    monkeypatch.setattr(
        speech_observations, "get_vad_model", lambda: lambda _samples: probability, raising=False
    )
    segments = [
        {"text": " We sing.", "start": 0.2, "end": 0.7},
        {"text": f" {credit}", "start": 1.2, "end": 1.7},
    ]
    payload = {"text": "".join(s["text"] for s in segments), "segments": segments}
    samples = np.full(48_000, 0.03, dtype=np.float32)

    result = speech_observations.discard_silent_segments(payload, samples)

    expected = segments if spoken else segments[:1]
    assert result["segments"] == expected
    assert result["text"] == "".join(s["text"] for s in expected)


@pytest.mark.parametrize(
    "text, spans, expected",
    [
        ("we still sing", [(1, 2), (2, 3), (3, 4)], "we still sing"),
        ("go go sing", [(1, 2), (2, 3), (3, 4)], "go go sing"),
        ("we sing we sing", [(1, 2), (2, 3), (3, 3), (3, 3)], "we sing"),
        ("we sing we sing", [(3, 3)] * 4, ""),
    ],
    ids=[
        "normal",
        "timed-repetition",
        "collapsed-duplicate-phrase",
        "all-collapsed",
    ],
)
def test_failed_word_timing_is_distinguished_from_a_collapsed_decoder_repetition(
    monkeypatch, text, spans, expected
):
    payload = {
        "text": text,
        "segments": [
            {
                "text": text,
                "words": [
                    {"word": word, "start": start, "end": end}
                    for word, (start, end) in zip(text.split(), spans, strict=True)
                ],
            }
        ],
    }
    monkeypatch.setattr(speech, "_guidance", lambda *_args, **_kwargs: payload)

    assert speech.transcribe(Path("vocal.wav"), "English")["text"] == expected


@pytest.mark.parametrize("mode", ["prefetched", "batch", "sequential"])
def test_asr_only_discovery_uses_original_mix_to_recover_a_missed_refrain(tmp_path, mode):
    original = tmp_path / "original.mp3"
    original.write_bytes(b"original audio identified by the fake provider")
    vocal = tmp_path / "vocal.wav"
    baseline = "Silver rain falls quietly\nThe river carries me"
    complete = baseline + "\nThe river carries me"
    calls = []

    class Views(FakeAiProvider):
        def transcribe(self, audio, *_args, **_kwargs):
            if mode == "prefetched":
                pytest.fail("Both independent recordings were already transcribed")
            calls.append(audio)
            return complete if audio == original else baseline

    class BatchViews(Views):
        def transcribe_many(self, requests, *_args, **_kwargs):
            calls.extend(audio for audio, _ in requests)
            return tuple(complete if audio == original else baseline for audio, _ in requests)

    prepared = PreparedLyrics(
        None, (), transcripts=(baseline, complete) if mode == "prefetched" else None
    )
    result = LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy()).discover(
        _song(original),
        vocal,
        BatchViews() if mode == "batch" else Views(),
        threading.Event(),
        online_enabled=False,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=prepared,
    )

    assert result.lyrics == complete
    assert result.source == "ASR"
    assert "LyricsRepeatsRecovered" in result.warnings
    assert calls == ([] if mode == "prefetched" else [vocal, original])


@pytest.mark.parametrize("original_state", ["absent", "missing", "same"])
def test_asr_only_discovery_does_not_decode_a_missing_or_identical_original(
    tmp_path, original_state
):
    vocal = tmp_path / "vocal.wav"
    vocal.write_bytes(b"vocal audio identified by the fake provider")
    source = {
        "absent": None,
        "missing": tmp_path / "missing.mp3",
        "same": vocal,
    }[original_state]
    calls = []
    text = "Silver rain falls quietly"

    class View(FakeAiProvider):
        def transcribe(self, audio, *_args, **_kwargs):
            calls.append(audio)
            return text

    result = LyricsDiscovery(LocalSidecarLyricsReader(), (), LyricsMatchPolicy()).discover(
        _song(source),
        vocal,
        View(),
        threading.Event(),
        online_enabled=False,
        execution=ExecutionContext(ComputeDevice.CPU, 1),
        prepared=PreparedLyrics(None, ()),
    )

    assert result.lyrics == text
    assert calls == [vocal]


def _song(source: Path | None) -> Song:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    return Song(
        "song",
        "Title",
        "Artist",
        "source",
        SourceState.MANAGED,
        source,
        SongStatus.IMPORTED,
        1,
        2,
        now,
        now,
        duration=120,
    )
