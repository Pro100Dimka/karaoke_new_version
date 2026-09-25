from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from backend.infrastructure.orm import SettingsRow
from backend.serialization import dumps, loads_object
from backend.models.domain import ComputeMode
from backend.settings.domain import BackendSettings, ProcessingBackend
from backend.version import SETTINGS_SCHEMA_VERSION


def _default_cpu_threads() -> int:
    return BackendSettings(settings_schema_version=SETTINGS_SCHEMA_VERSION).cpu_threads


def _to_domain(row: SettingsRow) -> BackendSettings:
    payload = loads_object(row.payload_json)
    return BackendSettings(
        settings_schema_version=row.settings_schema_version,
        compute_mode=ComputeMode(str(payload.get("computeMode", ComputeMode.AUTO.value))),
        cpu_threads=int(payload.get("cpuThreads", _default_cpu_threads())),
        selected_separation_provider=_optional_str(payload.get("selectedSeparationProvider")),
        selected_asr_provider=_optional_str(payload.get("selectedAsrProvider")),
        selected_pitch_provider=_optional_str(payload.get("selectedPitchProvider")),
        selected_alignment_provider=_optional_str(payload.get("selectedAlignmentProvider")),
        processing_backend=ProcessingBackend(
            str(payload.get("processingBackend", ProcessingBackend.LOCAL.value))
        ),
        kaggle_url=_optional_str(payload.get("kaggleUrl")),
        kaggle_token=_optional_str(payload.get("kaggleToken")),
    )


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


class SqlSettingsRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get(self) -> BackendSettings:
        row = self._session.scalar(select(SettingsRow).limit(1))
        if row is None:
            return BackendSettings(settings_schema_version=SETTINGS_SCHEMA_VERSION)
        return _to_domain(row)

    def save(self, settings: BackendSettings) -> None:
        row = self._session.scalar(select(SettingsRow).limit(1))
        if row is None:
            row = SettingsRow(
                settings_schema_version=settings.settings_schema_version, payload_json="{}"
            )
            self._session.add(row)
        row.settings_schema_version = settings.settings_schema_version
        row.payload_json = dumps(
            {
                "computeMode": settings.compute_mode,
                "cpuThreads": settings.cpu_threads,
                "selectedSeparationProvider": settings.selected_separation_provider,
                "selectedAsrProvider": settings.selected_asr_provider,
                "selectedPitchProvider": settings.selected_pitch_provider,
                "selectedAlignmentProvider": settings.selected_alignment_provider,
                "processingBackend": settings.processing_backend,
                "kaggleUrl": settings.kaggle_url,
                "kaggleToken": settings.kaggle_token,
            }
        )
