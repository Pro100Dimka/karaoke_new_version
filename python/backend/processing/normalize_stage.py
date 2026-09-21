from __future__ import annotations

import threading
from pathlib import Path

from backend.processing.cache_key import CacheIdentity, build_cache_key
from backend.processing.ports import AudioNormalizer, ProcessingCache
from backend.songs.domain import Song


class NormalizeStage:
    def __init__(
        self,
        normalizer: AudioNormalizer,
        cache: ProcessingCache,
        *,
        cpu_threads: int,
        algorithm_version: str = "normalize-1",
    ) -> None:
        self._normalizer = normalizer
        self._cache = cache
        self._threads = cpu_threads
        self._algorithm_version = algorithm_version

    def run(self, song: Song, workspace: Path, cancel: threading.Event) -> tuple[Path, bool]:
        if song.source_path is None:
            raise ValueError("Song has no managed source media")
        key = build_cache_key(
            CacheIdentity(
                input_identity=song.source_identity,
                model_id="ffmpeg",
                model_version="system",
                algorithm_version=self._algorithm_version,
                parameters={"sampleRate": 44100, "channels": 2, "sampleFormat": "s16"},
            )
        )
        cached = self._cache.get(key)
        if cached:
            return cached, True
        target = workspace / "normalized.wav"
        self._normalizer.normalize(song.source_path, target, threads=self._threads, cancel=cancel)
        return self._cache.put(key, target), False
