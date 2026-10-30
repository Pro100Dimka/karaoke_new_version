from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from backend.ai.domain import AiCapability, RequiredModel
from backend.domain_errors import ConflictError, DependencyError, DomainError, NotFoundError
from backend.runtime import Clock
from backend.models.domain import AiModel, ModelState
from backend.models.policy import ModelDownloadPolicy
from backend.models.ports import Downloader
from backend.persistence import UnitOfWorkFactory
from backend.processing.domain import Job, JobType
from backend.processing.job_manager import JobContext, ProcessingJobManager
from backend.songs.ports import FileHasher
from backend.storage.ports import ModelStorage, StorageSystem


class DeclareModel:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        clock: Clock,
        storage: ModelStorage,
        hasher: FileHasher,
    ) -> None:
        self._uow = uow
        self._clock = clock
        self._storage = storage
        self._hasher = hasher

    def execute(
        self,
        model_id: str,
        purpose: AiCapability,
        version: str,
        size: int,
        checksum: str,
        download_url: str | None,
        selected: bool,
    ) -> AiModel:
        if size < 0 or len(checksum) != 64:
            raise ValueError("Model size/checksum is invalid")
        with self._uow.create() as transaction:
            existing = transaction.models.get(model_id, version)
            state, local_path = self._local_state(existing, model_id, version, size, checksum)
            model = AiModel(
                model_id,
                purpose,
                version,
                size,
                checksum,
                state,
                selected,
                self._clock.now(),
                local_path,
                download_url,
            )
            transaction.models.add_or_update(model)
            transaction.commit()
        return model

    def _local_state(
        self,
        existing: AiModel | None,
        model_id: str,
        version: str,
        size: int,
        checksum: str,
    ) -> tuple[ModelState, Path | None]:
        candidate = self._storage.final_path(model_id, version)
        try:
            if candidate.is_file() and candidate.stat().st_size == size:
                if (
                    existing is not None
                    and existing.state is ModelState.READY
                    and existing.local_path == candidate
                    and existing.checksum == checksum
                    and existing.size == size
                ):
                    return ModelState.READY, candidate
                if self._hasher(candidate) == checksum:
                    return ModelState.READY, candidate
        except OSError:
            pass
        return ModelState.MISSING, None


class SelectModel:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, model_id: str, version: str) -> AiModel:
        with self._uow.create() as transaction:
            model = transaction.models.get(model_id, version)
            if model is None:
                raise NotFoundError("ModelMissing", "AI model was not found")
            if model.state is not ModelState.READY:
                raise ConflictError("ModelNotReady", "Only a verified model can be selected")
            selected = transaction.models.select(model_id, version)
            transaction.commit()
        return selected


class EnsureRequiredModels:
    def __init__(self, uow: UnitOfWorkFactory) -> None:
        self._uow = uow

    def execute(self, required: tuple[RequiredModel, ...] | list[RequiredModel]) -> None:
        with self._uow.create() as transaction:
            missing = transaction.models.missing(required)
        if missing:
            raise DependencyError(
                "MissingRequiredModels",
                "Required AI models are not installed and verified",
                models=[f"{item.model_id}:{item.version}" for item in missing],
            )


class DeleteModel:
    def __init__(
        self, uow: UnitOfWorkFactory, jobs: ProcessingJobManager,
        storage: ModelStorage, clock: Clock,
    ) -> None:
        self._uow, self._jobs, self._storage, self._clock = uow, jobs, storage, clock

    def execute(self, model_id: str, version: str) -> None:
        def remove() -> None:
            with self._uow.create() as transaction:
                model = transaction.models.get(model_id, version)
                if model is None:
                    raise NotFoundError("ModelMissing", "AI model was not found")
                self._storage.delete(self._storage.final_path(model_id, version))
                transaction.models.add_or_update(replace(
                    model, state=ModelState.MISSING, local_path=None,
                    selected=False, updated_at=self._clock.now(),
                ))
                transaction.commit()
        self._jobs.run_when_idle(remove)


class DownloadModel:
    def __init__(
        self,
        uow: UnitOfWorkFactory,
        jobs: ProcessingJobManager,
        downloader: Downloader,
        storage: ModelStorage,
        disks: StorageSystem,
        policy: ModelDownloadPolicy,
        clock: Clock,
        hasher: FileHasher,
    ) -> None:
        self._uow = uow
        self._jobs = jobs
        self._downloader = downloader
        self._storage = storage
        self._disks = disks
        self._policy = policy
        self._clock = clock
        self._hasher = hasher

    def execute(self, model_id: str, version: str) -> Job:
        model = self._get(model_id, version)
        if not model.download_url:
            raise DependencyError("ModelDownloadFailed", "Model has no download URL")
        self._disks.require_free(
            self._storage.final_path(model_id, version).parent,
            self._policy.required_disk_bytes(model.size),
        )
        return self._jobs.start(
            JobType.MODEL_DOWNLOAD,
            lambda context: self._run(model, context),
            entity_id=f"{model_id}:{version}",
        )

    def _run(self, model: AiModel, context: JobContext) -> dict[str, object]:
        temporary = self._storage.temporary_path(model.model_id, model.version)
        final = self._storage.final_path(model.model_id, model.version)
        completed = False
        try:
            self._set_state(model, ModelState.DOWNLOADING)
            context.progress("Download", 0.0, 0.0)
            size = self._downloader.download(
                model.download_url or "",
                temporary,
                timeout_seconds=self._policy.timeout_seconds,
                max_bytes=model.size,
                cancel=context.cancel,
                progress=lambda received: context.progress(
                    "Download", received / max(1, model.size), 0.95 * received / max(1, model.size)
                ),
            )
            context.ensure_not_cancelled()
            self._set_state(model, ModelState.VERIFYING)
            context.progress("Verify", 0.0, 0.95)
            self._verify(model, temporary, size)
            context.ensure_not_cancelled()
            self._storage.publish(temporary, final)
            ready = replace(
                model, state=ModelState.READY, local_path=final, updated_at=self._clock.now()
            )
            self._save(ready)
            completed = True
            return self._ready_result(model)
        except DomainError:
            context.ensure_not_cancelled()
            raise
        finally:
            if not completed:
                try:
                    self._storage.delete(temporary)
                finally:
                    self._set_state(model, ModelState.FAILED)

    def _ready_result(self, model: AiModel) -> dict[str, object]:
        return {
            "modelId": model.model_id,
            "version": model.version,
            "state": ModelState.READY.value,
        }

    def _get(self, model_id: str, version: str) -> AiModel:
        with self._uow.create() as transaction:
            model = transaction.models.get(model_id, version)
        if model is None:
            raise NotFoundError("ModelMissing", "AI model was not found")
        return model

    def _verify(self, model: AiModel, path: Path, size: int) -> None:
        if size != model.size:
            raise DependencyError(
                "ModelDownloadFailed", "Downloaded model size does not match manifest"
            )
        if self._hasher(path) != model.checksum:
            raise DependencyError("ModelDownloadFailed", "Downloaded model checksum is invalid")

    def _set_state(self, model: AiModel, state: ModelState) -> None:
        with self._uow.create() as transaction:
            current = transaction.models.get(model.model_id, model.version)
            # Download attempts do not invalidate already verified bytes, including
            # a newer successful attempt that finished while this one was running.
            if current is not None and current.state is ModelState.READY:
                if current.local_path and current.local_path.is_file():
                    return
            transaction.models.add_or_update(
                replace(current or model, state=state, updated_at=self._clock.now())
            )
            transaction.commit()

    def _save(self, model: AiModel) -> None:
        with self._uow.create() as transaction:
            transaction.models.add_or_update(model)
            transaction.commit()
