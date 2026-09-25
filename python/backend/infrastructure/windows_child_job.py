"""Own a subprocess tree before any of its user code can run."""

from __future__ import annotations

import ctypes
from ctypes import wintypes


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_int64),
        ("job_time", ctypes.c_int64),
        ("flags", wintypes.DWORD),
        ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t),
        ("active_process_limit", wintypes.DWORD),
        ("affinity", ctypes.c_size_t),
        ("priority", wintypes.DWORD),
        ("scheduling", wintypes.DWORD),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", _BasicLimits),
        ("io_counters", ctypes.c_uint64 * 6),
        ("process_memory", ctypes.c_size_t),
        ("job_memory", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t),
        ("peak_job_memory", ctypes.c_size_t),
    ]


class _ThreadEntry(ctypes.Structure):
    _fields_ = [
        ("size", wintypes.DWORD),
        ("usage", wintypes.DWORD),
        ("thread_id", wintypes.DWORD),
        ("process_id", wintypes.DWORD),
        ("base_priority", wintypes.LONG),
        ("delta_priority", wintypes.LONG),
        ("flags", wintypes.DWORD),
    ]


class WindowsChildJob:
    def __init__(self) -> None:
        self._api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            "SetInformationJobObject": (
                [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
                wintypes.BOOL,
            ),
            "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "CreateToolhelp32Snapshot": ([wintypes.DWORD, wintypes.DWORD], wintypes.HANDLE),
            "Thread32First": ([wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)], wintypes.BOOL),
            "Thread32Next": ([wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)], wintypes.BOOL),
            "OpenThread": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "ResumeThread": ([wintypes.HANDLE], wintypes.DWORD),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self._api, name)
            function.argtypes, function.restype = arguments, result
        self._handle = self._api.CreateJobObjectW(None, None)
        if not self._handle:
            raise ctypes.WinError()
        limits = _ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway allowed.
        if not self._api.SetInformationJobObject(
            self._handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            error = ctypes.WinError()
            self.close()
            raise error

    def attach_and_resume(self, pid: int) -> None:
        # Popen uses CREATE_SUSPENDED. Attaching a running process leaves a child-spawn race.
        process = self._api.OpenProcess(0x0101, False, pid)  # SET_QUOTA | TERMINATE
        if not process:
            raise ctypes.WinError()
        try:
            if not self._api.AssignProcessToJobObject(self._handle, process):
                raise ctypes.WinError()
        finally:
            self._api.CloseHandle(process)
        self._resume_initial_thread(pid)

    def _resume_initial_thread(self, pid: int) -> None:
        # Popen closes CreateProcess's primary-thread handle. A suspended, never-run process
        # has only that initial thread; reopen it through the documented Toolhelp API.
        snapshot = self._api.CreateToolhelp32Snapshot(0x00000004, 0)  # TH32CS_SNAPTHREAD
        if snapshot == ctypes.c_void_p(-1).value:
            raise ctypes.WinError()
        try:
            entry = _ThreadEntry()
            entry.size = ctypes.sizeof(entry)
            available = self._api.Thread32First(snapshot, ctypes.byref(entry))
            while available:
                if entry.process_id == pid:
                    thread = self._api.OpenThread(0x0002, False, entry.thread_id)
                    if not thread:
                        raise ctypes.WinError()
                    try:
                        if self._api.ResumeThread(thread) == 0xFFFFFFFF:
                            raise ctypes.WinError()
                    finally:
                        self._api.CloseHandle(thread)
                    return
                available = self._api.Thread32Next(snapshot, ctypes.byref(entry))
            raise OSError("The suspended subprocess has no initial thread")
        finally:
            self._api.CloseHandle(snapshot)

    def close(self) -> None:
        handle, self._handle = self._handle, None
        if handle:
            self._api.CloseHandle(handle)
