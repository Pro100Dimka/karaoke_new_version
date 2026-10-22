from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.ai.domain import PitchPoint, WordTiming
from backend.ai.ports import AiProvider
from backend.domain_errors import DomainError
from backend.lyrics.codec import decode_document
from backend.lyrics.domain import LyricsDocument
from backend.processing.algorithms import (
    MusicMetadata,
    construct_document,
    stabilize_pitch,
)
from backend.processing.domain import CancellationPolicy, ProcessingReport, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.compute_policy import ExecutionContext
from backend.processing.melody_reference import RenderMelodyReference
from backend.processing.preflight import provider_backend
from backend.processing.reporting import alignment_warnings, pitch_warnings, provider_provenance
from backend.processing.stage_runner import StageRunner
from backend.projects.ports import ProjectStorage
from backend.projects.publisher import ProjectPublisher
from backend.projects.validator import ProjectValidator
from backend.runtime import IdGenerator
from backend.songs.domain import Song
from backend.storage.ports import WorkStorage

_ALGORITHM_VERSION = "melody-2"


@dataclass(frozen=True, slots=True)
class MelodyInputs:
    song: Song
    document: LyricsDocument


class MelodyPipeline:
    """Rebuilds melody artifacts using an existing validated project revision."""

    def __init__(
        self,
        projects: ProjectStorage,
        validator: ProjectValidator,
        publisher: ProjectPublisher,
        melody: RenderMelodyReference,
        workspaces: WorkStorage,
        stages: StageRunner,
        ids: IdGenerator,
    ) -> None:
        self._projects = projects
        self._validator = validator
        self._publisher = publisher
        self._melody = melody
        self._workspaces = workspaces
        self._stages = stages
        self._ids = ids

    def load_inputs(self, song: Song) -> MelodyInputs:
        self._validator.validate(song.song_id, song.active_revision, require_ready=True)
        raw = self._projects.read_text_artifact(song.song_id, song.active_revision, "lyricsSync")
        try:
            document = decode_document(raw)
        except ValueError as exc:
            raise DomainError("ProjectInvalid", "lyricsSync.json is invalid", 400) from exc
        return MelodyInputs(song, document)

    def resource_size(self, inputs: MelodyInputs) -> int:
        return self._projects.portable_revision_size(
            inputs.song.song_id, inputs.song.active_revision
        )

    def run(
        self,
        inputs: MelodyInputs,
        provider: AiProvider,
        context: JobContext,
        execution: ExecutionContext,
        alignment: AiProvider | None = None,
    ) -> ProcessingReport:
        reports: list[StageReport] = []
        instrumental, reference = self._audio_paths(inputs.song)
        document, warnings = self._melody_document(
            inputs, provider, alignment, reference, context, reports, execution, instrumental
        )
        workspace = self._workspaces.allocate(f"melody-{inputs.song.song_id}")
        try:
            melody = self._stages.run(
                "MelodyReference",
                CancellationPolicy.FINISH_BEFORE_CANCEL,
                reports,
                context,
                lambda: self._melody.run(document, workspace),
                progress=0.96,
            )
            revision = self._publish(
                inputs.song,
                provider,
                alignment,
                instrumental,
                reference,
                melody,
                document,
                warnings,
                context,
                reports,
            )
        finally:
            self._workspaces.cleanup(workspace)
        return self._report(inputs.song, revision, reports, provider, alignment, warnings, execution)

    @staticmethod
    def _report(
        song: Song,
        revision: int,
        reports: list[StageReport],
        provider: AiProvider,
        alignment: AiProvider | None,
        warnings: tuple[str, ...],
        execution: ExecutionContext,
    ) -> ProcessingReport:
        return ProcessingReport(
            song_id=song.song_id,
            revision=revision,
            stages=tuple(reports),
            providers={
                name: item.descriptor.provider_id
                for name, item in (("pitch", provider), ("alignment", alignment))
                if item is not None
            },
            cache_used=False,
            warnings=(
                *warnings,
                *((execution.fallback_reason,) if execution.fallback_reason else ()),
            ),
            algorithm_version="lyrics-3" if alignment else _ALGORITHM_VERSION,
            timing_operation="lyrics" if alignment else "melody",
            processing_backend=provider_backend(provider).value,
        )

    def _audio_paths(self, song: Song) -> tuple[Path, Path]:
        instrumental = self._projects.artifact_path(
            song.song_id, song.active_revision, "instrumental"
        )
        reference = self._projects.artifact_path(
            song.song_id, song.active_revision, "referenceVocal"
        )
        return instrumental, reference

    def _melody_document(
        self,
        inputs: MelodyInputs,
        provider: AiProvider,
        alignment: AiProvider | None,
        reference: Path,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
        instrumental: Path,
    ) -> tuple[LyricsDocument, tuple[str, ...]]:
        document = inputs.document
        if alignment is not None:
            words = tuple(
                self._stages.run(
                    "ForcedAlignment",
                    CancellationPolicy.INTERRUPTIBLE,
                    reports,
                    context,
                    lambda: alignment.align(
                        reference,
                        document.lyrics,
                        inputs.song.language,
                        context.cancel,
                        execution=execution,
                        instrumental=instrumental,
                    ),
                    progress=0.3,
                )
            )
            warnings = alignment_warnings(words)
        else:
            words = tuple(
                WordTiming(word.text, word.start, word.end, 1.0, tuple(word.letters))
                for word in document.words
            )
            warnings = (f"ExistingWordTimingUnverified:sourceRevision={inputs.song.active_revision}",)
        stable = self._stable_pitch(provider, reference, context, reports, execution)
        return self._construct(document, words, stable, context, reports), warnings + pitch_warnings(stable)

    def _stable_pitch(
        self,
        provider: AiProvider,
        reference: Path,
        context: JobContext,
        reports: list[StageReport],
        execution: ExecutionContext,
    ) -> tuple[PitchPoint, ...]:
        pitch = self._stages.run(
            "PitchAnalysis",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: provider.pitch(reference, context.cancel, execution=execution),
            progress=0.45,
        )
        return self._stages.run(
            "PitchStabilization",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: stabilize_pitch(pitch),
            progress=0.65,
        )

    def _construct(
        self,
        document: LyricsDocument,
        words: tuple[WordTiming, ...],
        stable: tuple[PitchPoint, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> LyricsDocument:
        music = MusicMetadata(document.bpm, document.key)
        return self._stages.run(
            "NoteConstruction",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: construct_document(
                document.title,
                document.artist,
                document.duration,
                document.lyrics,
                words,
                stable,
                music,
            ),
            progress=0.88,
        )

    def _publish(
        self,
        song: Song,
        provider: AiProvider,
        alignment: AiProvider | None,
        instrumental: Path,
        reference: Path,
        melody: Path,
        document: LyricsDocument,
        warnings: tuple[str, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> int:
        return self._stages.run(
            "ProjectValidationPublication",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: self._publisher.publish_generated(
                song.song_id,
                song.active_revision,
                instrumental,
                reference,
                melody,
                document,
                self._provenance(song, provider, alignment, warnings),
                self._ids.new(),
            ),
            progress=1.0,
        )

    def _provenance(
        self,
        song: Song,
        provider: AiProvider,
        alignment: AiProvider | None,
        warnings: tuple[str, ...],
    ) -> dict[str, object]:
        return {
            "algorithmVersion": "lyrics-3" if alignment else _ALGORITHM_VERSION,
            "providers": {
                name: provider_provenance(item.descriptor)
                for name, item in (("pitch", provider), ("alignment", alignment))
                if item is not None
            },
            "sourceRevision": song.active_revision,
            "lyricsSource": "ExistingProjectText",
            "warnings": list(warnings),
        }
