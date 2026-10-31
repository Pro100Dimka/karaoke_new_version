from __future__ import annotations

from collections.abc import Sequence
from collections import defaultdict
import re
from statistics import median

from backend.ai.domain import AiProviderDescriptor, PitchPoint, WordTiming
from backend.lyrics.phrases import _lyrics_key
from backend.processing.domain import ProcessingReport


def alignment_warnings(
    words: Sequence[WordTiming], *, lyrics: str = "", bpm: float | None = None
) -> tuple[str, ...]:
    """Zero support includes proportional fallback; it is not a precise alignment."""
    approximate = [str(index) for index, word in enumerate(words) if word.confidence <= 0]
    warnings = (f"AlignmentApproximate:wordIndices={','.join(approximate)}",) if approximate else ()
    return (
        warnings
        + tuple(rate_reviews(words, lyrics, bpm).values())
        + tuple(
            f"AlignmentDiagnostic:wordIndex={index};{reason}"
            for index, word in enumerate(words)
            for reason in word.diagnostics
        )
    )


def _timing_load(text: str) -> tuple[int, int]:
    # Vowel groups estimate syllables; spelling is not an exact pronunciation model.
    return sum(char.isalpha() for char in text), max(
        1, len(re.findall(r"[aeiouy]+|[аеёиоуыэюяіїє]", text.casefold()))
    )


def rate_reviews(
    words: Sequence[WordTiming], lyrics: str = "", bpm: float | None = None
) -> dict[tuple[int, int], str]:
    """Select suspicious timings for acoustic review; these are not human speed limits."""
    repeated: dict[str, list[float]] = defaultdict(list)
    for word in words:
        repeated[_lyrics_key(word.text)].append(max(word.end - word.start, 0.001))
    warnings: dict[tuple[int, int], str] = {}
    for index, word in enumerate(words):
        duration = max(word.end - word.start, 0.001)
        letters, syllables = _timing_load(word.text)
        examples = repeated[_lyrics_key(word.text)]
        reasons = [
            reason
            for reason, active in {
                "BoundaryConflict": "BoundaryConflict" in word.diagnostics,
                "TimingReviewRequired": "TimingReviewRequired" in word.diagnostics,
                "CollapsedWord": letters > 0 and duration + 1e-9 < 0.005,
                "HighWrittenRate": letters >= 5 and letters > 45 * duration + 1e-9,
                "HighVowelGroupRate": syllables >= 2 and syllables > 15 * duration + 1e-9,
                "ShortAgainstSameWord": letters >= 2
                and len(examples) >= 3
                and duration < 0.3
                and median(examples) > 3 * duration + 1e-9,
                "CollapsedLetterRun": sum(
                    right - left + 1e-9 < 0.005
                    for left, right in zip(word.letters, word.letters[1:])
                )
                >= 3,
            }.items()
            if active
        ]
        if reasons:
            warnings[index, index + 1] = (
                f"AlignmentRateReview:wordIndex={index};lettersPerSecond={letters / duration:.2f};"
                f"vowelGroupsPerSecond={syllables / duration:.2f};reasons={','.join(reasons)}"
            )
    phrases: list[tuple[int, int, str, float, int]] = []
    first = 0
    for line in lyrics.splitlines():
        last = first + len(line.split())
        span = words[first:last]
        letters, syllables = _timing_load(line)
        if (
            len(span) == last - first
            and len(span) >= 3
            and letters >= 12
            and _lyrics_key(line) == "".join(_lyrics_key(word.text) for word in span)
        ):
            rate = letters / max(span[-1].end - span[0].start, 0.001)
            phrases.append((first, last, _lyrics_key(line), rate, syllables))
        first = last
    baseline = median(item[3] for item in phrases) if phrases else 0.0
    rates: dict[str, list[float]] = defaultdict(list)
    for _, _, key, rate, _ in phrases:
        rates[key].append(rate)
    for first, last, key, rate, syllables in phrases:
        other_rates = rates[key].copy()
        other_rates.remove(rate)
        if rate <= 3 * baseline + 1e-9 and not (
            other_rates and rate > 2 * median(other_rates) + 1e-9
        ):
            continue
        duration = max(words[last - 1].end - words[first].start, 0.001)
        beat_load = (
            f";vowelGroupsPerBeat={syllables * 60 / bpm / duration:.2f}" if bpm and bpm > 0 else ""
        )
        warnings[first, last] = (
            f"AlignmentRateReview:wordRange={first}-{last};lettersPerSecond={rate:.2f}"
            f";relativeToTypicalPhrase={rate / baseline:.2f}{beat_load}"
        )
    return warnings


def pitch_warnings(points: Sequence[PitchPoint]) -> tuple[str, ...]:
    missing = sum(point.audio_active is None for point in points)
    return (
        (f"PitchActivityUnavailable:frames={missing};unobservedGapsNotBridged",) if missing else ()
    )


def provider_provenance(descriptor: AiProviderDescriptor) -> dict[str, object]:
    return {
        "providerId": descriptor.provider_id,
        "providerVersion": descriptor.version,
        "models": [
            {
                "modelId": model.model_id,
                "modelVersion": model.version,
                "modelChecksum": model.checksum,
            }
            for model in descriptor.required_models
        ],
    }


def report_payload(report: ProcessingReport) -> dict[str, object]:
    return {
        "songId": report.song_id,
        "revision": report.revision,
        "algorithmVersion": report.algorithm_version,
        "timingOperation": report.timing_operation,
        **({"processingBackend": report.processing_backend} if report.processing_backend else {}),
        "providers": dict(report.providers),
        "cacheUsed": report.cache_used,
        "warnings": list(report.warnings),
        "stages": [
            {
                "stage": item.stage,
                "durationSeconds": item.duration_seconds,
                "cancellationPolicy": item.cancellation_policy.value,
            }
            for item in report.stages
        ],
    }
