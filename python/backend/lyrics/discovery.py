from __future__ import annotations

import threading
from collections import Counter
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Sequence

from backend.ai.ports import AiProvider, BatchTranscriber
from backend.domain_errors import DependencyError, DomainError
from backend.lyrics.catalogue_lookup import (
    CatalogueCache,
    LyricsMatchPolicy as LyricsMatchPolicy,
    matches_metadata,
    select_catalogue,
    supported_alternative,
)
from backend.lyrics.catalogue_versions import reconcile_timed_overlaps
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
from backend.text_normalization import (
    clean_lyrics,
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
    online_candidates: tuple[tuple[int, tuple[LyricsCandidate, ...]], ...] = ()


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
        original_audio: Path | None = None,
    ) -> LyricsDiscoveryResult:
        source = prepared if prepared is not None else self.lookup(song, cancel, online_enabled)
        sources = [reference_vocal]
        original = original_audio if original_audio is not None else song.source_path
        if original and original != reference_vocal and original.is_file():
            sources.append(original)
        return self._performed(
            song,
            sources,
            asr,
            cancel,
            source,
            execution,
            online_enabled,
        )

    def lookup(self, song: Song, cancel: threading.Event, online_enabled: bool) -> PreparedLyrics:
        local = self._local(song)
        warnings: list[str] = []
        cache: CatalogueCache = {}
        previous = self._previous(song, warnings) if local is None else None
        found = (
            local
            or (
                self._from_online(song, cancel, warnings, previous, cache=cache)
                if online_enabled
                else None
            )
            or previous
        )
        if found:
            found = _clean_match(song, found)
        return PreparedLyrics(found, tuple(warnings), online_candidates=tuple(cache.items()))

    def _performed(
        self,
        song: Song,
        sources: Sequence[Path],
        asr: AiProvider,
        cancel: threading.Event,
        source: PreparedLyrics,
        execution: ExecutionContext,
        online_enabled: bool,
    ) -> LyricsDiscoveryResult:
        found, warnings = source.found, list(source.warnings)
        recognized, ending = self._transcripts(
            song, sources, asr, cancel, found, execution, source.transcripts
        )
        transcripts = [
            clean_lyrics(lyrics, lyrics_language(song, found.lyrics if found else lyrics).value)
            for lyrics in recognized
        ]
        found = self._recognized_catalogue(
            song, source, transcripts, cancel, warnings, online_enabled
        )
        if found:
            # Reconcile while every catalogue cue is still available, before repeat recovery
            # drops ambiguous cues or stores the catalogue as its verification baseline.
            reconciled = reconcile_timed_overlaps(
                LyricsCandidate(
                    found.lyrics,
                    song.title,
                    song.artist,
                    song.duration,
                    found.source,
                    found.timing_hints,
                ),
                found.alternatives,
                transcripts,
                _lyrics_key,
            )
            found = replace(found, lyrics=reconciled.lyrics, timing_hints=reconciled.timing_hints)
        for lyrics in transcripts:
            if found:
                found = _with_completed_repeats(found, lyrics, cancel)
            elif lyrics:
                found = LyricsDiscoveryResult(lyrics, "ASR", tuple(warnings))
        if found is None:
            raise DependencyError("LyricsUnavailable", "No lyrics source produced usable lyrics")
        found = self._ending(song, sources, asr, cancel, found, execution, ending)
        return replace(
            found,
            timing_hints=reconcile_timing_hints(found.lyrics, found.timing_hints),
            repeat_baseline_hints=reconcile_timing_hints(
                found.repeat_baseline or found.lyrics, found.repeat_baseline_hints
            ),
        )

    def _recognized_catalogue(
        self,
        song: Song,
        source: PreparedLyrics,
        transcripts: Sequence[str],
        cancel: threading.Event,
        warnings: list[str],
        online_enabled: bool,
    ) -> LyricsDiscoveryResult | None:
        found = self._recognized_version(song, source.found, transcripts)
        if source.found is not None and found is None:
            warnings.append("LyricsCatalogRejected")
        if found is None and online_enabled:
            found = self._from_online(
                song,
                cancel,
                warnings,
                transcripts=transcripts,
                cache=dict(source.online_candidates),
            )
            return _clean_match(song, found) if found is not None else None
        return found

    def _transcripts(
        self,
        song: Song,
        sources: Sequence[Path],
        asr: AiProvider,
        cancel: threading.Event,
        found: LyricsDiscoveryResult | None,
        execution: ExecutionContext,
        prefetched: Sequence[str] | None = None,
    ) -> tuple[Sequence[str], tuple[Language, Sequence[str]] | None]:
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
        sources: Sequence[Path],
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
            and supported_alternative(song, item, found.lyrics, self._policy, transcripts)
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
        return _clean_match(song, selected)

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
        cache: CatalogueCache | None = None,
    ) -> LyricsDiscoveryResult | None:
        selected = select_catalogue(
            self._online,
            song,
            self._policy,
            cancel,
            warnings,
            {} if cache is None else cache,
            transcripts,
        )
        if selected is None:
            return None
        if not matches_metadata(song, selected.matched, self._policy):
            previous = None
        return self._select_version(
            song,
            selected.candidates,
            selected.matched,
            previous,
            warnings,
            selected.source,
            transcripts,
        )

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


def _clean_match(song: Song, found: LyricsDiscoveryResult) -> LyricsDiscoveryResult:
    language = lyrics_language(song, found.lyrics).value
    return replace(
        found,
        lyrics=clean_lyrics(found.lyrics, language),
        timing_hints=tuple(
            replace(hint, text=clean_lyrics(hint.text, language)) for hint in found.timing_hints
        ),
    )


def _cached_catalog_text(lyrics: str, saved: object, hints: tuple[LyricLineTiming, ...]) -> str:
    text = saved if isinstance(saved, str) and saved.split() == lyrics.split() else lyrics
    catalog = "\n".join(hint.text for hint in hints)
    # Recover phrase boundaries only when the complete catalogue has the same words.
    return strip_catalog_credits(catalog if catalog.split() == text.split() else text)


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
