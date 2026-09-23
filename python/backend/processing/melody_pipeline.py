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
    refine_words,
    stabilize_pitch,
)
from backend.processing.domain import CancellationPolicy, ProcessingReport, StageReport
from backend.processing.job_manager import JobContext
from backend.processing.melody_reference import RenderMelodyReference
from backend.processing.stage_runner import StageRunner
from backend.projects.ports import ProjectStorage
from backend.projects.publisher import ProjectPublisher
from backend.projects.validator import ProjectValidator
from backend.runtime import IdGenerator
from backend.songs.domain import Song
from backend.storage.ports import WorkStorage

_ALGORITHM_VERSION = "melody-1"


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
    ) -> ProcessingReport:
        reports: list[StageReport] = []
        instrumental, reference = self._audio_paths(inputs.song)
        document = self._melody_document(inputs, provider, reference, context, reports)
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
                inputs.song, provider, instrumental, reference, melody, document, context, reports
            )
        finally:
            self._workspaces.cleanup(workspace)
        return ProcessingReport(
            song_id=inputs.song.song_id,
            revision=revision,
            stages=tuple(reports),
            providers={"pitch": provider.descriptor.provider_id},
            cache_used=False,
            warnings=(),
            algorithm_version=_ALGORITHM_VERSION,
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
        reference: Path,
        context: JobContext,
        reports: list[StageReport],
    ) -> LyricsDocument:
        stable = self._stable_pitch(provider, reference, context, reports)
        words = self._refined_words(inputs.document, stable, context, reports)
        return self._construct(inputs.document, words, stable, context, reports)

    def _stable_pitch(
        self,
        provider: AiProvider,
        reference: Path,
        context: JobContext,
        reports: list[StageReport],
    ) -> tuple[PitchPoint, ...]:
        pitch = self._stages.run(
            "PitchAnalysis",
            CancellationPolicy.INTERRUPTIBLE,
            reports,
            context,
            lambda: provider.pitch(reference, context.cancel),
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

    def _refined_words(
        self,
        document: LyricsDocument,
        stable: tuple[PitchPoint, ...],
        context: JobContext,
        reports: list[StageReport],
    ) -> tuple[WordTiming, ...]:
        source = tuple(
            WordTiming(word.text, word.start, word.end, 1.0, tuple(word.letters))
            for word in document.words
        )
        return self._stages.run(
            "VoicedIntervalMapping",
            CancellationPolicy.FINISH_BEFORE_CANCEL,
            reports,
            context,
            lambda: refine_words(source, stable),
            progress=0.78,
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
        instrumental: Path,
        reference: Path,
        melody: Path,
        document: LyricsDocument,
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
                self._provenance(song, provider),
                self._ids.new(),
            ),
            progress=1.0,
        )

    def _provenance(self, song: Song, provider: AiProvider) -> dict[str, object]:
        descriptor = provider.descriptor
        models = [
            {
                "modelId": model.model_id,
                "modelVersion": model.version,
                "modelChecksum": model.checksum,
            }
            for model in descriptor.required_models
        ]
        return {
            "algorithmVersion": _ALGORITHM_VERSION,
            "providers": {
                "pitch": {
                    "providerId": descriptor.provider_id,
                    "providerVersion": descriptor.version,
                    "models": models,
                }
            },
            "sourceRevision": song.active_revision,
        }
