from __future__ import annotations

import hashlib
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from threading import RLock

from backend.domain_errors import DomainError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.serialization import dumps, loads_list


@dataclass
class _Reservation:
    owner: str
    participants: tuple[str, ...]
    size: int


class RoomUploadStorage:
    """One quota for projects and singer sources, including unfinished parallel uploads."""

    def __init__(
        self,
        root: Path,
        *,
        account_bytes: int | None = None,
        total_bytes: int | None = None,
        reserve_bytes: int | None = None,
    ) -> None:
        self.root = root.resolve()
        self.account_bytes = (
            account_bytes
            if account_bytes is not None
            else int(os.getenv("AD_VOICE_ACCOUNT_STORAGE_BYTES", str(10 * 1024**3)))
        )
        self.total_bytes = (
            total_bytes
            if total_bytes is not None
            else int(os.getenv("AD_VOICE_SERVER_STORAGE_BYTES", str(64 * 1024**3)))
        )
        self.reserve_bytes = (
            reserve_bytes
            if reserve_bytes is not None
            else int(os.getenv("AD_VOICE_SERVER_DISK_RESERVE_BYTES", str(2 * 1024**3)))
        )
        if min(self.account_bytes, self.total_bytes) <= 0 or self.reserve_bytes < 0:
            raise ValueError("Storage quotas must be positive; disk reserve cannot be negative")
        self._lock = RLock()
        self._pending: dict[Path, _Reservation] = {}
        self._deleted: set[str] = set()

    @staticmethod
    def _owned(file: Path, participants: tuple[str, ...]) -> bool:
        hashes = {hashlib.sha256(participant.encode()).hexdigest() for participant in participants}
        return any(
            part in hashes
            or part in {value[:32] for value in hashes}
            or part.removesuffix(".zip") in hashes
            or any(part.startswith(f".{value}.zip.") for value in hashes)
            for part in file.parts
        )

    def _files(self) -> dict[Path, int]:
        files = {}
        for item in self.root.rglob("*"):
            try:
                if item.is_file() and not item.is_symlink():
                    files[item] = item.stat().st_size
            except FileNotFoundError:
                continue
        return files

    def _check(self, target: Path, item: _Reservation) -> None:
        if self._deleted.intersection(item.participants):
            raise DomainError("AccountDeleted", "This account has been deleted", 403)
        files = self._files()
        pending_files = {
            file
            for file in files
            if any(
                file.parent == pending.parent
                and file.name.startswith(f".{pending.name}.")
                and file.suffix == ".upload"
                for pending in self._pending
            )
        }
        committed = [file for file in files if file not in pending_files]
        account_used = sum(
            files[file]
            for file in committed
            if file not in self._pending
            and self._owned(file.relative_to(self.root), item.participants)
        )
        pending = tuple(self._pending.values())
        account_used += sum(value.size for value in pending if value.owner == item.owner)
        if account_used > self.account_bytes:
            raise DomainError(
                "AccountStorageQuotaExceeded",
                "Account storage quota exceeded",
                413,
                {"maximumBytes": self.account_bytes},
            )
        if (
            sum(files[file] for file in committed) + sum(value.size for value in pending)
            > self.total_bytes
        ):
            raise DomainError("ServerStorageQuotaExceeded", "Server storage quota exceeded", 413)
        self.root.mkdir(parents=True, exist_ok=True)
        outstanding = max(
            0, sum(value.size for value in pending) - sum(files[file] for file in pending_files)
        )
        if shutil.disk_usage(self.root).free - outstanding < self.reserve_bytes:
            raise DomainError("ServerStorageUnavailable", "Not enough free server disk space", 507)

    def reserve(self, target: Path, owner: str, participants: tuple[str, ...], size: int) -> None:
        target = target.resolve()
        if not target.is_relative_to(self.root) or size < 0:
            raise ValueError("Invalid upload reservation")
        with self._lock:
            if target in self._pending:
                raise DomainError("UploadInProgress", "This file is already being uploaded", 409)
            item = _Reservation(owner, participants, size)
            self._pending[target] = item
            try:
                self._check(target, item)
            except BaseException:
                self._pending.pop(target)
                raise

    def grow(self, target: Path, size: int) -> None:
        with self._lock:
            item = self._pending[target.resolve()]
            if self._deleted.intersection(item.participants):
                raise DomainError("AccountDeleted", "This account has been deleted", 403)
            if size > item.size:
                previous = item.size
                item.size = size
                try:
                    self._check(target, item)
                except BaseException:
                    item.size = previous
                    raise

    def commit(self, target: Path, temporary: Path) -> None:
        with self._lock:
            item = self._pending[target.resolve()]
            if self._deleted.intersection(item.participants):
                raise DomainError("AccountDeleted", "This account has been deleted", 403)
            os.replace(temporary, target)
            self._pending.pop(target.resolve())

    def release(self, target: Path) -> None:
        with self._lock:
            self._pending.pop(target.resolve(), None)

    def erase(self, participants: tuple[str, ...]) -> None:
        with self._lock:
            if any(
                set(participants).intersection(item.participants) for item in self._pending.values()
            ):
                raise DomainError(
                    "AccountUploadInProgress",
                    "Wait for active uploads before deleting the account",
                    409,
                )
            self._deleted.update(participants)
            for file in self._files():
                relative = file.relative_to(self.root)
                if self._owned(relative, participants):
                    file.unlink(missing_ok=True)
                elif file.name == "members.json":
                    members = loads_list(file.read_text(encoding="utf-8"))
                    retained = [member for member in members if member not in participants]
                    if retained != members:
                        atomic_write_text(file, dumps(retained))
