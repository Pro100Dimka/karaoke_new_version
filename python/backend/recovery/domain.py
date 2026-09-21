from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Mapping


class RecoveryOperation(StrEnum):
    IMPORT_SONG = "ImportSong"
    PROJECT_PUBLISH = "ProjectPublish"
    PACKAGE_IMPORT = "PackageImport"
    MODEL_DOWNLOAD = "ModelDownload"
    SONG_DELETE = "SongDelete"
    RECORDING_REGISTER = "RecordingRegister"
    RECORDING_DELETE = "RecordingDelete"


@dataclass(frozen=True, slots=True)
class RecoveryEntry:
    transaction_id: str
    operation: RecoveryOperation
    created_at: datetime
    data: Mapping[str, object]


class RecoveryAction(StrEnum):
    REPAIR_REQUIRED = "RepairRequired"
    REPROCESS_REQUIRED = "ReprocessRequired"
    MANUAL_ACTION_REQUIRED = "ManualActionRequired"


@dataclass(frozen=True, slots=True)
class ReconciliationIssue:
    code: str
    entity_id: str
    action: RecoveryAction
    details: Mapping[str, object]
