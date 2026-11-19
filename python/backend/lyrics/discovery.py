from __future__ import annotations

import threading
from collections import Counter
from dataclasses import dataclass, replace
from difflib import SequenceMatcher
from pathlib import Path
from typing import Sequence

from backend.ai.ports import AiProvider, BatchTranscriber
from backend.domain_errors import DependencyError, DomainError
from backend.lyrics.codec import (
    decode_document,
    decode_timing_hints,
    decode_lrc,
    reconcile_timing_hints,
)
from backend.lyrics.phrases import (
    _complete_repeats as _complete_repeats,
    _lyrics_match as _lyrics_match,
    _same_vocabulary as _same_vocabulary,
    _best_catalog_version as _best_catalog_version,
    _performed_coverage as _performed_coverage,
    _timed_catalog_version as _timed_catalog_version,
    _catalog_distances,
    _catalog_matches_performance,
    _line_matches as _line_matches,
    _lyrics_key as _lyrics_key,
    _merge_lines as _merge_lines,
    performed_phrases as performed_phrases,
)
from backend.projects.ports import ProjectStorage
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from backend.text_normalization import (
    normalize_catalog_identity,
    clean_lyrics,
    strip_annotations,
    strip_catalog_credits,
)
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
    duration_tolerance_fraction: float = 0.10


@dataclass(frozen=True, slots=True)
class LyricsDiscoveryResult:
    lyrics: str
    source: str
    warnings: tuple[str, ...]
    timing_hints: tuple[LyricLineTiming, ...] = ()
    alternatives: tuple[LyricsCandidate, ...] = ()
    repeat_baseline: str = ""
    repeat_baseline_hints: tuple[LyricLineTiming, ...] = ()
    unverified_repeat_lyrics: str = ""


@dataclass(frozen=True, slots=True)
class PreparedLyrics:
    found: LyricsDiscoveryResult | None
    warnings: tuple[str, ...]
    transcripts: tuple[str, ...] | None = None


def lyrics_ending_start(song: Song, found: LyricsDiscoveryResult | None) -> float | None:
    return (
        song.duration - 48
        if found is not None
        and found.source != "ASR"
        and song.duration is not None
        and song.duration > 48
        else None
    )


class LyricsDiscovery:
    def __init__(
        self,
        sidecar: SidecarLyricsReader,
        online: Sequence[OnlineLyricsProvider],
        policy: LyricsMatchPolicy,
        *,
        projects: ProjectStorage | None = None,
    ) -> None:
        self._sidecar = sidecar
        self._online = tuple(online)
        self._policy = policy
        self._projects = projects

    def discover(
        self,
        song: Song,
        reference_vocal: Path,
        asr: AiProvider,
        cancel: threading.Event,
        *,
        online_enabled: bool,
        execution: ExecutionContext,
        prepared: PreparedLyrics | None = None,
    ) -> LyricsDiscoveryResult:
        source = prepared if prepared is not None else self.lookup(song, cancel, online_enabled)
        return self._performed(
            song,
            reference_vocal,
            asr,
            cancel,
            source,
            execution,
            online_enabled,
        )

    def lookup(self, song: Song, cancel: threading.Event, online_enabled: bool) -> PreparedLyrics:
        local = self._local(song)
        warnings: list[str] = []
        previous = self._previous(song, warnings) if local is None else None
        found = (
            local
            or (self._from_online(song, cancel, warnings, previous) if online_enabled else None)
            or previous
        )
        if found:
            language = lyrics_language(song, found.lyrics).value
            found = replace(
                found,
                lyrics=clean_lyrics(found.lyrics, language),
                timing_hints=tuple(
                    replace(hint, text=clean_lyrics(hint.text, language))
                    for hint in found.timing_hints
                ),
            )
        return PreparedLyrics(found, tuple(warnings))

    def _performed(
        self,
        song: Song,
        reference_vocal: Path,
        asr: AiProvider,
        cancel: threading.Event,
        source: PreparedLyrics,
        execution: ExecutionContext,
        online_enabled: bool,
    ) -> LyricsDiscoveryResult:
        found, warnings = source.found, list(source.warnings)
        recognized, ending = self._transcripts(
            song, reference_vocal, asr, cancel, found, execution, source.transcripts
        )
        language = lyrics_language(song, found.lyrics if found else "")
        transcripts = [
            clean_lyrics(lyrics, language.value if found else lyrics_language(song, lyrics).value)
            for lyrics in recognized
        ]
        found = self._recognized_version(song, found, transcripts)
        if source.found is not None and found is None:
            warnings.append("LyricsCatalogRejected")
            if online_enabled:
                found = self._from_online(song, cancel, warnings, transcripts=transcripts)
        for lyrics in transcripts:
            if found:
                found = _with_completed_repeats(found, lyrics, cancel)
            elif lyrics:
                found = LyricsDiscoveryResult(lyrics, "ASR", tuple(warnings))
        if found is None:
            raise DependencyError("LyricsUnavailable", "No lyrics source produced usable lyrics")
        found = self._ending(song, reference_vocal, asr, cancel, found, execution, ending)
        return replace(
            found,
            timing_hints=reconcile_timing_hints(found.lyrics, found.timing_hints),
            repeat_baseline_hints=reconcile_timing_hints(
                found.repeat_baseline or found.lyrics, found.repeat_baseline_hints
            ),
        )

    def _transcripts(
        self,
        song: Song,
        reference_vocal: Path,
        asr: AiProvider,
        cancel: threading.Event,
        found: LyricsDiscoveryResult | None,
        execution: ExecutionContext,
        prefetched: Sequence[str] | None = None,
    ) -> tuple[Sequence[str], tuple[Language, Sequence[str]] | None]:
        sources = [reference_vocal]
        if song.source_path and song.source_path.is_file():
            sources.append(song.source_path)
        sources = list(dict.fromkeys(sources))
        language = lyrics_language(song, found.lyrics if found else "")
        ending = lyrics_ending_start(song, found)
        if prefetched is not None:
            return prefetched[: len(sources)], (
                (language, prefetched[len(sources) :]) if ending is not None else None
            )
        if isinstance(asr, BatchTranscriber):
            requests = [(source, 0.0) for source in sources]
            if ending is not None:
                requests.extend((source, ending) for source in sources)
            transcripts = asr.transcribe_many(requests, language, cancel, execution=execution)
            return transcripts[: len(sources)], (
                (language, transcripts[len(sources) :]) if ending is not None else None
            )
        return (
            [asr.transcribe(source, language, cancel, execution=execution) for source in sources],
            None,
        )

    def _ending(
        self,
        song: Song,
        vocal: Path,
        asr: AiProvider,
        cancel: threading.Event,
        found: LyricsDiscoveryResult,
        execution: ExecutionContext,
        recognized: tuple[Language, Sequence[str]] | None = None,
    ) -> LyricsDiscoveryResult:
        # Keep the preceding phrase in context: a short sung answer alone is often decoded as silence.
        if found.source == "ASR" or not song.duration or song.duration <= 48:
            return found
        language = lyrics_language(song, found.lyrics)
        sources = [vocal]
        if song.source_path and song.source_path != vocal and song.source_path.is_file():
            sources.append(song.source_path)
        heard = (
            recognized[1]
            if recognized is not None and recognized[0] is language
            else [
                asr.transcribe(
                    source, language, cancel, execution=execution, start_seconds=song.duration - 48
                )
                for source in sources
            ]
        )
        # Separation can suppress quiet replies. Reconcile each view independently so
        # hearing the same reply in both cannot count it twice.
        for transcript in heard:
            found = _with_completed_repeats(found, clean_lyrics(transcript, language.value), cancel)
        return found

    def _recognized_version(
        self, song: Song, found: LyricsDiscoveryResult | None, transcripts: Sequence[str]
    ) -> LyricsDiscoveryResult | None:
        if found is None or found.source in ["LocalSidecar", "EmbeddedLyrics", "ASR"]:
            return found
        alternatives = tuple(
            item
            for item in found.alternatives
            if _catalog_matches_performance(item.lyrics, transcripts)
        )
        if not alternatives:
            return (
                found
                if not found.alternatives
                and _catalog_matches_performance(found.lyrics, transcripts)
                else None
            )
        selected = self._select_version(
            song,
            alternatives,
            alternatives[0],
            None,
            list(found.warnings),
            found.source,
            transcripts,
        )
        language = lyrics_language(song, selected.lyrics).value
        return replace(
            selected,
            lyrics=clean_lyrics(selected.lyrics, language),
            timing_hints=tuple(
                replace(hint, text=clean_lyrics(hint.text, language))
                for hint in selected.timing_hints
            ),
        )

    def _previous(self, song: Song, warnings: list[str]) -> LyricsDiscoveryResult | None:
        if self._projects is None:
            return None
        try:
            manifest = self._projects.load_manifest(song.song_id, song.active_revision)
            source = manifest.provenance.get("lyricsSource")
            if not isinstance(source, str) or source == "ASR":
                return None
            raw = self._projects.read_text_artifact(
                song.song_id, song.active_revision, "lyricsBaseline"
            )
            document = decode_document(raw)
            hints = decode_timing_hints(
                manifest.provenance.get("lyricsTimingHints"), document.duration
            )
            lyrics = _cached_catalog_text(
                document.lyrics, manifest.provenance.get("lyricsSourceText"), hints
            )
            saved_warnings = manifest.provenance.get("warnings", ())
            recovered = (
                isinstance(saved_warnings, (tuple, list))
                and "LyricsRepeatsRecovered" in saved_warnings
            )
        except (DomainError, ValueError, OSError):
            return None
        return (
            LyricsDiscoveryResult(
                lyrics,
                source,
                (
                    *warnings,
                    "LyricsCatalogCached",
                    *(("LyricsRepeatsRecovered",) if recovered else ()),
                ),
                hints,
            )
            if lyrics.strip()
            else None
        )

    def _local(self, song: Song) -> LyricsDiscoveryResult | None:
        sidecar = self._sidecar.read(song.source_path) if song.source_path else None
        text = sidecar or song.embedded_lyrics
        if text and text.strip():
            timed = decode_lrc(text)
            return LyricsDiscoveryResult(
                "\n".join(line for _, line in timed) if timed else text.strip(),
                "LocalSidecar" if sidecar else "EmbeddedLyrics",
                (),
                tuple(LyricLineTiming(start, line) for start, line in timed),
            )
        return None

    def _from_online(
        self,
        song: Song,
        cancel: threading.Event,
        warnings: list[str],
        previous: LyricsDiscoveryResult | None = None,
        *,
        transcripts: Sequence[str] = (),
    ) -> LyricsDiscoveryResult | None:
        for provider in self._online:
            try:
                candidates = provider.search(song, song.language, cancel)
            except DependencyError as exc:
                warnings.append(f"{provider.provider_id}:{exc.code}")
                continue
            candidates = tuple(
                item
                for item in candidates
                if _catalog_matches_performance(item.lyrics, transcripts)
            )
            matches = [item for item in candidates if self._matches(song, item)]
            if matches:
                eligible = [
                    item for item in candidates if self._matches(song, item, check_artist=False)
                ]
                return self._select_version(
                    song,
                    eligible,
                    matches[0],
                    previous,
                    warnings,
                    provider.provider_id,
                    transcripts,
                )
        return None

    def _select_version(
        self,
        song: Song,
        eligible: Sequence[LyricsCandidate],
        matched: LyricsCandidate,
        previous: LyricsDiscoveryResult | None,
        warnings: list[str],
        source: str,
        transcripts: Sequence[str] = (),
    ) -> LyricsDiscoveryResult:
        versions = [
            item
            for item in eligible
            if transcripts or _same_vocabulary(matched.lyrics, item.lyrics)
        ]
        distances = _catalog_distances(eligible, song.duration)
        candidate = _best_catalog_version(versions, distances, transcripts)
        cached_distances = [
            distances[item]
            for item in versions
            if previous and _lyrics_key(previous.lyrics) == _lyrics_key(item.lyrics)
        ]
        if cached_distances and min(cached_distances) > distances[candidate]:
            warnings.append("LyricsCatalogVersionChanged")
        if previous and (
            "LyricsCatalogVersionChanged" not in warnings
            and "LyricsRepeatsRecovered" not in previous.warnings
            and _same_vocabulary(candidate.lyrics, previous.lyrics)
            and len(previous.lyrics.split()) > len(candidate.lyrics.split())
        ):
            return previous
        timed = _timed_catalog_version(eligible, candidate, distances)
        return LyricsDiscoveryResult(
            candidate.lyrics,
            source,
            tuple(warnings),
            timed.timing_hints if timed else candidate.timing_hints,
            tuple(dict.fromkeys([matched, *eligible])),
        )

    def _matches(
        self,
        song: Song,
        candidate: LyricsCandidate,
        *,
        check_artist: bool = True,
    ) -> bool:
        if not _similar(song.title, candidate.title):
            return False
        if (
            check_artist
            and song.artist != UNKNOWN_ARTIST
            and not _similar(song.artist, candidate.artist)
        ):
            return False
        if song.duration is None or candidate.duration is None:
            return True
        tolerance = max(
            self._policy.duration_tolerance_seconds,
            song.duration * self._policy.duration_tolerance_fraction,
        )
        return abs(song.duration - candidate.duration) <= tolerance


def _cached_catalog_text(lyrics: str, saved: object, hints: tuple[LyricLineTiming, ...]) -> str:
    text = saved if isinstance(saved, str) and saved.split() == lyrics.split() else lyrics
    catalog = "\n".join(hint.text for hint in hints)
    # Recover phrase boundaries only when the complete catalogue has the same words.
    return strip_catalog_credits(catalog if catalog.split() == text.split() else text)


_SIMILARITY = 0.84


def _similar(expected: str, actual: str) -> bool:
    """Catalog titles differ from file names by brackets, case and punctuation, so names are compared loosely."""
    left = normalize_catalog_identity(strip_annotations(expected))
    right = normalize_catalog_identity(strip_annotations(actual))
    return bool(left) and bool(right) and SequenceMatcher(None, left, right).ratio() >= _SIMILARITY


def lyrics_language(song: Song, lyrics: str = "") -> Language:
    if song.language is not Language.AUTO:
        return song.language
    identity = f"{song.artist} {song.title} {lyrics}"
    if any(char in "іїєґ" for char in identity.casefold()):
        return Language.UKRAINIAN
    return (
        Language.RUSSIAN
        if any("а" <= char.casefold() <= "я" for char in identity)
        else Language.AUTO
    )


def _with_completed_repeats(
    found: LyricsDiscoveryResult, lyrics: str, cancel: threading.Event
) -> LyricsDiscoveryResult:
    lead_hints = reconcile_timing_hints(found.lyrics, found.timing_hints)
    if lead_hints != found.timing_hints and [hint.text for hint in lead_hints] == [
        line.strip() for line in found.lyrics.splitlines() if line.strip()
    ]:
        # Complete lead cues exclude concurrent backing. ASR hears both parts and
        # cannot establish an extra lead occurrence from the combined transcript.
        return found
    completed = _complete_repeats(found.lyrics, lyrics, cancel)
    before = Counter(_lyrics_key(line) for line in found.lyrics.splitlines())
    after = Counter(_lyrics_key(line) for line in completed.splitlines())
    return (
        found
        if completed == found.lyrics
        else replace(
            found,
            lyrics=completed,
            repeat_baseline=found.repeat_baseline or found.lyrics,
            repeat_baseline_hints=(
                found.repeat_baseline_hints if found.repeat_baseline else found.timing_hints
            ),
            timing_hints=tuple(
                hint
                for hint in found.timing_hints
                if before[_lyrics_key(hint.text)] == after[_lyrics_key(hint.text)]
            ),
            warnings=tuple(dict.fromkeys((*found.warnings, "LyricsRepeatsRecovered"))),
        )
    )
