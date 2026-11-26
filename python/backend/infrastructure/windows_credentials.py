"""Persistent per-user Windows credentials, independent of the installation directory."""

from __future__ import annotations

import ctypes
import hashlib
import os
from contextlib import contextmanager
from ctypes import wintypes
from typing import Iterator


class _Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


class WindowsCredentials:
    def __init__(self, target: str) -> None:
        self.target = target
        self._api = ctypes.WinDLL("advapi32", use_last_error=True)
        self._api.CredReadW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(ctypes.POINTER(_Credential)),
        ]
        self._api.CredReadW.restype = wintypes.BOOL
        self._api.CredWriteW.argtypes = [ctypes.POINTER(_Credential), wintypes.DWORD]
        self._api.CredWriteW.restype = wintypes.BOOL
        self._api.CredFree.argtypes = [ctypes.c_void_p]
        self._api.CredFree.restype = None

    def read(self) -> str | None:
        value = ctypes.POINTER(_Credential)()
        if not self._api.CredReadW(self.target, 1, 0, ctypes.byref(value)):
            error = ctypes.get_last_error()
            if error == 1168:  # ERROR_NOT_FOUND, other failures must never reset identity.
                return None
            raise ctypes.WinError(error)
        try:
            return ctypes.string_at(
                value.contents.CredentialBlob, value.contents.CredentialBlobSize
            ).decode("utf-8")
        finally:
            self._api.CredFree(value)

    def write(self, text: str) -> None:
        data = text.encode("utf-8")
        if len(data) > 2560:
            raise ValueError("Account credential is too large")
        blob = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
        value = _Credential(
            Type=1,
            TargetName=self.target,
            CredentialBlobSize=len(data),
            CredentialBlob=blob,
            Persist=2,
            UserName="AD Voice",
        )
        if not self._api.CredWriteW(ctypes.byref(value), 0):
            raise ctypes.WinError(ctypes.get_last_error())

    @contextmanager
    def locked(self) -> Iterator[None]:
        """Serialize migration across installed/development processes and Windows sessions."""
        owner = f"{os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}"
        name = hashlib.sha256(f"{owner}:{self.target}".encode()).hexdigest()
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
        kernel.CreateMutexW.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
        kernel.ReleaseMutex.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        handle = kernel.CreateMutexW(None, False, f"Global\\ADVoice.Account.{name}")
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        acquired = False
        try:
            acquired = kernel.WaitForSingleObject(handle, 5000) in [0, 0x80]
            if not acquired:
                raise TimeoutError("Account migration is busy")
            yield
        finally:
            if acquired:
                kernel.ReleaseMutex(handle)
            kernel.CloseHandle(handle)
