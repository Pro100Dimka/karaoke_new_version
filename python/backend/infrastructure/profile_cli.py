"""Move the installed profile before activation after an update."""

from __future__ import annotations
import argparse
import os
import time
from collections.abc import Callable
from pathlib import Path
from backend.domain_errors import ConflictError
from backend.infrastructure.atomic_files import atomic_write_text
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.infrastructure.profile_cleanup import _finish, _unlink_compatibility
from backend.infrastructure.profile_progress import _report, start_progress, close_progress
from backend.infrastructure.process_runner import run_entrypoint
from backend.serialization import loads_object


def run_profile_command(migrate: Callable[..., None]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--wait-parent", type=int, default=0)
    parser.add_argument("--finish-marker", type=Path)
    parser.add_argument("--unlink-compatibility", action="store_true")
    parser.add_argument("--handoff-file", type=Path)
    args = parser.parse_args()
    try:
        return run_entrypoint(lambda: _execute(args, migrate), _report_error)
    finally:
        close_progress()


def _execute(args: argparse.Namespace, migrate: Callable[..., None]) -> int:
    if args.unlink_compatibility:
        _unlink_compatibility(args.target)
    elif args.finish_marker:
        marker = args.finish_marker.absolute()
        if (
            marker.parent.resolve() != args.target.parent.resolve()
            or marker.name != ".storage-cleanup"
        ):
            raise ValueError("Invalid migration completion marker")
        if args.handoff_file:
            handoff = args.handoff_file.absolute()
            if (
                handoff.parent.resolve() != marker.parent.resolve()
                or not handoff.name.startswith(".storage-worker-")
                or handoff.suffix != ".pid"
            ):
                raise ValueError("Invalid migration worker handoff")
            atomic_write_text(handoff, str(os.getpid()))
        lease = _completion_lock(marker)
        try:
            start_progress(marker.parent)
            print("STORAGE_CLEANUP|started", flush=True)
            _finish(
                loads_object(marker.read_text(encoding="utf-8")),
                marker,
                wait_parent=args.wait_parent,
            )
            print("STORAGE_CLEANUP|complete", flush=True)
        finally:
            lease.release()
    else:
        migrate(args.profile, args.target, wait_parent=args.wait_parent)
    return 0


def _report_error(exc: Exception) -> None:
    _report("Error", detail=str(exc))
    print(f"STORAGE_ERROR|{exc}", flush=True)


def _completion_lock(marker: Path) -> BackendInstanceLock:
    lease = BackendInstanceLock(marker.parent / ".storage-worker.lock", adopt_marker=True)
    deadline = time.monotonic() + 10
    while True:
        try:
            lease.acquire()
            break
        except ConflictError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)
    return lease
