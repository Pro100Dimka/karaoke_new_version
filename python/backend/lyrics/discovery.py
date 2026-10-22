from __future__ import annotations

import threading
import math
from collections import Counter
from dataclasses import dataclass, replace
from difflib import SequenceMatcher
from pathlib import Path
from typing import Sequence

from backend.ai.ports import AiProvider
from backend.domain_errors import ConflictError, DependencyError, DomainError
from backend.lyrics.codec import decode_document
from backend.projects.ports import ProjectStorage
from backend.songs.filename_metadata import UNKNOWN_ARTIST
from backend.text_normalization import normalize_catalog_identity, spell_lyric_percentages, strip_annotations
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


class LyricsDiscovery:
    def __init__(
        self,
        sidecar: SidecarLyricsReader,
        online: Sequence[OnlineLyricsProvider],
        policy: LyricsMatchPolicy,
        *, projects: ProjectStorage | None = None,
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
    ) -> LyricsDiscoveryResult:
        local = self._local(song)
        warnings: list[str] = []
        found = local or (self._from_online(song, cancel, warnings) if online_enabled else None)
        previous = self._previous(song, warnings) if local is None else None
        if previous and (found is None or (
            _same_vocabulary(found.lyrics, previous.lyrics)
            and len(previous.lyrics.split()) > len(found.lyrics.split())
        )):
            found = previous
        if found:
            language = lyrics_language(song, found.lyrics).value
            found = replace(
                found, lyrics=spell_lyric_percentages(found.lyrics, language),
                timing_hints=tuple(replace(hint, text=spell_lyric_percentages(hint.text, language))
                                   for hint in found.timing_hints),
            )
        lyrics = asr.transcribe(
            reference_vocal, lyrics_language(song, found.lyrics if found else ""),
            cancel, execution=execution,
        ).strip()
        if found:
            completed = _complete_repeats(found.lyrics, lyrics, cancel)
            return found if completed == found.lyrics else replace(
                found, lyrics=completed, timing_hints=(),
                warnings=(*found.warnings, "LyricsRepeatsRecovered"),
            )
        if not lyrics:
            raise DependencyError("LyricsUnavailable", "No lyrics source produced usable lyrics")
        return LyricsDiscoveryResult(lyrics, "ASR", tuple(warnings))

    def _previous(self, song: Song, warnings: list[str]) -> LyricsDiscoveryResult | None:
        if self._projects is None:
            return None
        try:
            manifest = self._projects.load_manifest(song.song_id, song.active_revision)
            source = manifest.provenance.get("lyricsSource")
            if not isinstance(source, str) or source == "ASR":
                return None
            raw = self._projects.read_text_artifact(song.song_id, song.active_revision, "lyricsBaseline")
            lyrics = decode_document(raw).lyrics
        except (DomainError, ValueError, OSError):
            return None
        return (
            LyricsDiscoveryResult(lyrics, source, (*warnings, "LyricsCatalogCached"))
            if lyrics.strip() else None
        )

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
                versions = [item for item in candidates
                            if self._matches(song, item, check_artist=False)
                            and _same_vocabulary(candidate.lyrics, item.lyrics)]
                candidate = max(versions, key=lambda item: len(item.lyrics.split()))
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

    def _matches(
        self, song: Song, candidate: LyricsCandidate, *, check_artist: bool = True,
    ) -> bool:
        if not _similar(song.title, candidate.title):
            return False
        if check_artist and song.artist != UNKNOWN_ARTIST and not _similar(song.artist, candidate.artist):
            return False
        if song.duration is None or candidate.duration is None:
            return True
        tolerance = max(
            self._policy.duration_tolerance_seconds,
            song.duration * self._policy.duration_tolerance_fraction,
        )
        return abs(song.duration - candidate.duration) <= tolerance


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


def _same_vocabulary(expected: str, actual: str) -> bool:
    vocabularies = [" ".join(sorted({_lyrics_key(word) for word in text.split() if _lyrics_key(word)}))
                    for text in (expected, actual)]
    return _lyrics_match(*vocabularies)


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


def _lyrics_key(text: str) -> str:
    return "".join(char for char in text.casefold() if char.isalpha())


def _complete_repeats(lyrics: str, transcript: str, cancel: threading.Event) -> str:
    """Recover performed catalogue phrases without replacing good words with ASR spelling.

    Phrase selection scores matching characters against recognition errors. A nonsequential
    phrase costs log2(catalogue size), so repeats need evidence instead of a duration rule.
    A shortest common supersequence retains every original line when ASR misses quiet singing.
    """
    lines = [line for line in lyrics.splitlines() if _lyrics_key(line)]
    keys = list(dict.fromkeys(_lyrics_key(line) for line in lines))
    if not keys or not transcript:
        return lyrics
    original = [keys.index(_lyrics_key(line)) for line in lines]
    heard = [_lyrics_key(word) for word in transcript.split() if _lyrics_key(word)]
    performed = tuple(index for index, _, _ in _performed_lines(
        keys, heard, set(zip(original, original[1:])), cancel,
    ))
    merged = _merge_lines(original, performed, keys)
    if len(merged) == len(original):
        return lyrics
    written = {_lyrics_key(line): line for line in reversed(lines)}
    return "\n".join(written[keys[index]] for index in merged)


_LinePath = tuple[float, tuple[tuple[int, int, int], ...]]


def performed_phrases(
    lyrics: str, words: Sequence[str], cancel: threading.Event,
) -> tuple[tuple[str, int, int], ...]:
    """Catalogue phrase and the independent ASR word span that supports each occurrence."""
    lines = [line for line in lyrics.splitlines() if _lyrics_key(line)]
    keys = list(dict.fromkeys(_lyrics_key(line) for line in lines))
    if not keys or not words:
        return ()
    original = [keys.index(_lyrics_key(line)) for line in lines]
    matches = _performed_lines(
        keys, [_lyrics_key(word) for word in words], set(zip(original, original[1:])), cancel,
    )
    return tuple((lines[original.index(index)], first, last) for index, first, last in matches)


def _performed_lines(
    keys: list[str], heard: list[str], following: set[tuple[int, int]], cancel: threading.Event,
) -> tuple[tuple[int, int, int], ...]:
    states: list[dict[int, _LinePath]] = [{} for _ in range(len(heard) + 1)]
    states[0][-1] = (0.0, ())
    choice_cost = math.log2(len(keys) + 1)
    empty: _LinePath = (-math.inf, ())
    for start in range(len(heard)):
        if cancel.is_set():
            raise ConflictError("JobCancelled", "Lyrics coverage check was cancelled")
        row = states[start]
        best = max(row.values(), key=lambda item: item[0])
        for last, (score, path) in row.items():
            # ASR may miss quiet words or invent unrelated text. Leaving it unmatched must
            # not reward forcing a weakly similar catalogue phrase into the performance.
            skipped = (score, path)
            if skipped[0] > states[start + 1].get(last, empty)[0]:
                states[start + 1][last] = skipped
        for index, key in enumerate(keys):
            sequential = max(
                (value for last, value in row.items() if (last, index) in following),
                key=lambda item: item[0], default=empty,
            )
            score, path = max(
                ((best[0] - choice_cost, best[1]), sequential), key=lambda item: item[0],
            )
            for end, support in _line_matches(key, heard, start):
                candidate = (score + support, (*path, (index, start, end)))
                if candidate[0] > states[end].get(index, empty)[0]:
                    states[end][index] = candidate
    return max(states[-1].values(), key=lambda item: item[0])[1]


def _line_matches(key: str, heard: list[str], start: int) -> list[tuple[int, int]]:
    matches: list[tuple[int, int]] = []
    joined = ""
    for end in range(start, len(heard)):
        joined += heard[end]
        # Beyond twice the phrase length even a complete character match cannot score positively.
        if len(joined) > 2 * len(key):
            break
        blocks = [block for block in SequenceMatcher(
            None, key, joined, autojunk=False,
        ).get_matching_blocks() if block.size]
        if not blocks or blocks[0].b >= len(heard[start]):
            continue
        if blocks[-1].b + blocks[-1].size <= len(joined) - len(heard[end]):
            continue
        matched = sum(block.size for block in blocks)
        support = 2 * matched - max(len(key), len(joined))
        if support > 0:
            matches.append((end + 1, support))
    return matches


def _merge_lines(original: list[int], performed: tuple[int, ...], keys: list[str]) -> list[int]:
    counts = Counter(original)
    equivalent = {
        (left, right): left == right or (
            keys[right] in keys[left]
            # The same positive character support used by phrase recognition. Keep the
            # catalogue's extra words when ASR misses a short adlib inside an occurrence.
            and 2 * len(keys[right]) > len(keys[left])
        ) for left in counts for right in set(performed)
    }
    lengths = [[0.0] * (len(performed) + 1) for _ in range(len(original) + 1)]
    for i in range(len(original) - 1, -1, -1):
        for j in range(len(performed) - 1, -1, -1):
            lengths[i][j] = (
                lengths[i + 1][j + 1] + 1 / counts[original[i]] if equivalent[original[i], performed[j]]
                else max(lengths[i + 1][j], lengths[i][j + 1])
            )
    merged: list[int] = []
    i = j = 0
    while i < len(original) and j < len(performed):
        if equivalent[original[i], performed[j]]:
            merged.append(original[i])
            i, j = i + 1, j + 1
        elif lengths[i + 1][j] > lengths[i][j + 1]:
            merged.append(original[i])
            i += 1
        else:
            merged.append(performed[j])
            j += 1
    return merged + original[i:] + list(performed[j:])
