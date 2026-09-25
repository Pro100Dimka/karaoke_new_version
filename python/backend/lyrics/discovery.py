from __future__ import annotations

import threading
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from typing import Sequence

from backend.ai.ports import AiProvider
from backend.domain_errors import DependencyError
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from backend.text_normalization import normalize_catalog_identity, strip_annotations
from backend.lyrics.ports import (
    LyricLineTiming,
    LyricsCandidate,
    OnlineLyricsProvider,
    SidecarLyricsReader,
)
from backend.songs.domain import Language, Song
from backend.processing.compute_policy import ExecutionContext


@dataclass(frozen=True, slots=True)
class LyricsMatchPolicy:
    duration_tolerance_seconds: float = 8.0


@dataclass(frozen=True, slots=True)
class LyricsDiscoveryResult:
    lyrics: str
    source: str
    warnings: tuple[str, ...]
    timing_hints: tuple[LyricLineTiming, ...] = ()


class LyricsDiscovery:
    def __init__(
        self,
        sidecar: SidecarLyricsReader,
        online: Sequence[OnlineLyricsProvider],
        policy: LyricsMatchPolicy,
    ) -> None:
        self._sidecar = sidecar
        self._online = tuple(online)
        self._policy = policy

    def discover(
        self,
        song: Song,
        reference_vocal: Path,
        asr: AiProvider,
        cancel: threading.Event,
        *,
        online_enabled: bool,
        execution: ExecutionContext,
    ) -> LyricsDiscoveryResult:
        local = self._local(song)
        if local:
            return local
        warnings: list[str] = []
        if online_enabled:
            online = self._from_online(song, cancel, warnings)
            if online:
                return online
        lyrics = asr.transcribe(
            reference_vocal, _asr_language(song), cancel, execution=execution
        ).strip()
        if not lyrics:
            raise DependencyError("LyricsUnavailable", "No lyrics source produced usable lyrics")
        return LyricsDiscoveryResult(lyrics, "ASR", tuple(warnings))

    def _local(self, song: Song) -> LyricsDiscoveryResult | None:
        if song.source_path:
            sidecar = self._sidecar.read(song.source_path)
            if sidecar:
                return LyricsDiscoveryResult(sidecar, "LocalSidecar", ())
        if song.embedded_lyrics and song.embedded_lyrics.strip():
            return LyricsDiscoveryResult(song.embedded_lyrics.strip(), "EmbeddedLyrics", ())
        return None

    def _from_online(
        self,
        song: Song,
        cancel: threading.Event,
        warnings: list[str],
    ) -> LyricsDiscoveryResult | None:
        for provider in self._online:
            try:
                candidates = provider.search(song, song.language, cancel)
            except DependencyError as exc:
                warnings.append(f"{provider.provider_id}:{exc.code}")
                continue
            matches = [item for item in candidates if self._matches(song, item)]
            candidate = matches[0] if matches else None
            if candidate:
                timed = next(
                    (
                        item
                        for item in matches
                        if item.timing_hints and _lyrics_match(candidate.lyrics, item.lyrics)
                    ),
                    None,
                )
                return LyricsDiscoveryResult(
                    candidate.lyrics,
                    provider.provider_id,
                    tuple(warnings),
                    timed.timing_hints if timed else candidate.timing_hints,
                )
        return None

    def _matches(self, song: Song, candidate: LyricsCandidate) -> bool:
        if not _similar(song.title, candidate.title):
            return False
        if song.artist != UNKNOWN_ARTIST and not _similar(song.artist, candidate.artist):
            return False
        if song.duration is None or candidate.duration is None:
            return True
        return abs(song.duration - candidate.duration) <= self._policy.duration_tolerance_seconds


_SIMILARITY = 0.84


def _similar(expected: str, actual: str) -> bool:
    """Catalog titles differ from file names by brackets, case and punctuation, so names are compared loosely."""
    left = normalize_catalog_identity(strip_annotations(expected))
    right = normalize_catalog_identity(strip_annotations(actual))
    return bool(left) and bool(right) and SequenceMatcher(None, left, right).ratio() >= _SIMILARITY


def _lyrics_match(expected: str, actual: str) -> bool:
    left = expected.casefold().split()
    right = actual.casefold().split()
    return SequenceMatcher(None, left, right, autojunk=False).ratio() >= 0.90


def _asr_language(song: Song) -> Language:
    if song.language is not Language.AUTO:
        return song.language
    identity = f"{song.artist} {song.title}"
    return (
        Language.RUSSIAN
        if any("а" <= char.casefold() <= "я" for char in identity)
        else Language.AUTO
    )
