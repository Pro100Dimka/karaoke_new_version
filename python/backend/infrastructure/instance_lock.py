from __future__ import annotations

import os
import ctypes
import errno
import sys
from ctypes import wintypes
from pathlib import Path
from uuid import uuid4

from backend.domain_errors import ConflictError, DependencyError
from backend.serialization import dumps, loads_object


class BackendInstanceLock:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._token = str(uuid4())
        self._owned = False
        self._guard: int | None = None

    def acquire(self) -> None:
        if self._owned:
            raise ConflictError("BackendAlreadyRunning", "Another backend owns this library")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._acquire_guard()
            self._acquire_marker()
        finally:
            if not self._owned:
                self._release_guard()

    def _acquire_guard(self) -> None:
        # Keep this inode: unlinking an OS lock file would let another opener lock a new inode.
        # The marker remains compatible with older backends and is only changed under this lease.
        try:
            self._guard = os.open(f"{self._path}.guard", os.O_RDWR | os.O_CREAT, 0o600)
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(self._guard, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise ConflictError(
                    "BackendAlreadyRunning", "Another backend owns this library"
                ) from exc
            raise DependencyError(
                "BackendInstanceLockUnavailable", "Backend instance lock cannot be created"
            ) from exc

    def _release_guard(self) -> None:
        descriptor, self._guard = self._guard, None
        if descriptor is not None:
            os.close(descriptor)

    def _acquire_marker(self) -> None:
        payload = dumps({"pid": os.getpid(), "token": self._token})
        for _ in range(2):
            created = False
            try:
                descriptor = os.open(self._path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                created = True
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
                if created:
                    self._path.unlink(missing_ok=True)
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
            self._release_guard()

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
    if os.name == "nt":
        return _windows_process_exists(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _windows_process_exists(pid: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    kernel32.CloseHandle.restype = wintypes.BOOL
    synchronize = 0x00100000
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        # Only ERROR_INVALID_PARAMETER proves that the PID is absent. Access denied is not absence.
        return ctypes.get_last_error() != 87
    try:
        return bool(kernel32.WaitForSingleObject(handle, 0) != 0)  # WAIT_OBJECT_0 means exited.
    finally:
        kernel32.CloseHandle(handle)
