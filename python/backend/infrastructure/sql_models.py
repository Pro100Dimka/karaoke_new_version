from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from backend.ai.domain import AiCapability, RequiredModel
from backend.infrastructure.sql_time import as_utc
from backend.infrastructure.orm import ModelRow
from backend.models.domain import AiModel, ModelState


def _to_domain(row: ModelRow) -> AiModel:
    return AiModel(
        model_id=row.model_id,
        purpose=AiCapability(row.purpose),
        version=row.version,
        size=row.size,
        checksum=row.checksum,
        state=ModelState(row.state),
        local_path=Path(row.local_path) if row.local_path else None,
        selected=row.selected,
        download_url=row.download_url,
        updated_at=as_utc(row.updated_at),
    )


class SqlModelRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self, model_id: str, version: str) -> AiModel | None:
        row = self._session.scalar(
            select(ModelRow).where(ModelRow.model_id == model_id, ModelRow.version == version)
        )
        return _to_domain(row) if row else None

    def add_or_update(self, model: AiModel) -> None:
        row = self._session.scalar(
            select(ModelRow).where(
                ModelRow.model_id == model.model_id,
                ModelRow.version == model.version,
            )
        )
        if row is None:
            row = ModelRow(model_id=model.model_id, version=model.version)
            self._session.add(row)
        row.purpose = model.purpose.value
        row.size = model.size
        row.checksum = model.checksum
        row.state = model.state.value
        row.local_path = str(model.local_path) if model.local_path else None
        row.selected = model.selected
        row.download_url = model.download_url
        row.updated_at = model.updated_at

    def list(self, purpose: AiCapability | None = None) -> Sequence[AiModel]:
        query = select(ModelRow)
        if purpose:
            query = query.where(ModelRow.purpose == purpose.value)
        query = query.order_by(ModelRow.purpose, ModelRow.model_id, ModelRow.version)
        return [_to_domain(row) for row in self._session.scalars(query).all()]

    def select(self, model_id: str, version: str) -> AiModel:
        row = self._session.scalar(
            select(ModelRow).where(ModelRow.model_id == model_id, ModelRow.version == version)
        )
        if row is None:
            raise KeyError((model_id, version))
        self._session.execute(
            update(ModelRow).where(ModelRow.purpose == row.purpose).values(selected=False)
        )
        row.selected = True
        return _to_domain(row)

    def missing(self, required: Sequence[RequiredModel]) -> Sequence[RequiredModel]:
        missing: list[RequiredModel] = []
        for requirement in required:
            model = self.get(requirement.model_id, requirement.version)
            ready = (
                model and model.state is ModelState.READY and model.checksum == requirement.checksum
            )
            if not ready:
                missing.append(requirement)
        return missing
