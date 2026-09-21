from __future__ import annotations

from backend.bootstrap.container import ModelCases
from backend.bootstrap.wiring import ProcessingWiring, RuntimeWiring
from backend.infrastructure.http_downloader import HttpDownloader
from backend.infrastructure.local_storage import LocalModelStorage
from backend.models.commands import DeclareModel, DownloadModel, SelectModel
from backend.models.policy import ModelDownloadPolicy
from backend.models.queries import ListModels


def build_model_cases(
    runtime: RuntimeWiring,
    processing: ProcessingWiring,
    storage: LocalModelStorage,
) -> ModelCases:
    download = DownloadModel(
        runtime.database,
        processing.jobs,
        HttpDownloader(),
        storage,
        processing.storage,
        ModelDownloadPolicy(),
        runtime.clock,
        runtime.hasher,
    )
    return ModelCases(
        DeclareModel(runtime.database, runtime.clock),
        SelectModel(runtime.database),
        ListModels(runtime.database),
        download,
    )
