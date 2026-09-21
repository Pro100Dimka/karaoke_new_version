from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from backend.domain_errors import ConflictError, DependencyError
from backend.serialization import dumps, loads_object


class BackendInstanceLock:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._token = str(uuid4())
        self._owned = False

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = dumps({"pid": os.getpid(), "token": self._token})
        for _ in range(2):
            try:
                descriptor = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                self._owned = True
                return
            except FileExistsError:
                if not self._remove_stale():
                    raise ConflictError(
                        "BackendAlreadyRunning", "Another backend owns this library"
                    )
            except OSError as exc:
                raise DependencyError(
                    "BackendInstanceLockUnavailable", "Backend instance lock cannot be created"
                ) from exc
        raise ConflictError("BackendAlreadyRunning", "Another backend owns this library")

    def release(self) -> None:
        if not self._owned:
            return
        try:
            data = loads_object(self._path.read_text(encoding="utf-8"))
            if data.get("token") == self._token:
                self._path.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
        finally:
            self._owned = False

    def _remove_stale(self) -> bool:
        try:
            data = loads_object(self._path.read_text(encoding="utf-8"))
            pid = int(data.get("pid", -1))
        except (OSError, ValueError, TypeError):
            pid = -1
        if pid > 0 and _process_exists(pid):
            return False
        try:
            self._path.unlink(missing_ok=True)
        except OSError:
            return False
        return True


def _process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True
