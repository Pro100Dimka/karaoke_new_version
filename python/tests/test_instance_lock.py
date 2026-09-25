import subprocess
import sys
import os
from pathlib import Path

import pytest

from backend.domain_errors import ConflictError
from backend.infrastructure.instance_lock import BackendInstanceLock
from backend.serialization import dumps


def test_contender_cannot_replace_owner_during_stale_marker_recovery(tmp_path, monkeypatch):
    path = tmp_path / "backend.lock"
    path.write_text(dumps({"pid": -1, "token": "crashed"}), encoding="utf-8")
    owner, contender = BackendInstanceLock(path), BackendInstanceLock(path)
    original_unlink = Path.unlink
    intercepted = False
    rejected = False

    def before_unlink(target, *args, **kwargs):
        nonlocal intercepted, rejected
        if target == path and not intercepted:
            intercepted = True
            try:
                contender.acquire()
            except ConflictError:
                rejected = True
        return original_unlink(target, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", before_unlink)
    try:
        owner.acquire()
        assert intercepted and rejected, "Stale cleanup must not unlink a new live owner's marker"
    finally:
        owner.release()
        contender.release()


def test_crashed_owner_releases_os_lock_for_recovery(tmp_path):
    path = tmp_path / "backend.lock"
    child = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "from pathlib import Path; import sys; "
            "from backend.infrastructure.instance_lock import BackendInstanceLock; "
            "lock=BackendInstanceLock(Path(sys.argv[1])); lock.acquire(); "
            "print('ready', flush=True); sys.stdin.read(1); __import__('os')._exit(1)",
            str(path),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    recovered = BackendInstanceLock(path)
    try:
        assert child.stdout.readline().strip() == b"ready"
        with pytest.raises(ConflictError):
            recovered.acquire()
        child.communicate(input=b"x", timeout=5)
        recovered.acquire()
    finally:
        recovered.release()
        if child.poll() is None:
            child.kill()
            child.communicate(timeout=5)


def test_failed_metadata_write_releases_ownership(tmp_path, monkeypatch):
    from backend.domain_errors import DependencyError

    path = tmp_path / "backend.lock"
    owner = BackendInstanceLock(path)
    with monkeypatch.context() as patch:
        patch.setattr(os, "fsync", lambda _: (_ for _ in ()).throw(OSError("disk failure")))
        with pytest.raises(DependencyError):
            owner.acquire()
    recovered = BackendInstanceLock(path)
    try:
        recovered.acquire()
    finally:
        recovered.release()


def test_rejecting_a_live_library_owner_does_not_terminate_that_process(tmp_path, monkeypatch):
    def no_signal(*args):
        pytest.fail("A Windows liveness probe must not send console signals")

    if sys.platform == "win32":
        monkeypatch.setattr(os, "kill", no_signal)
    child = subprocess.Popen(
        [sys.executable, "-c", "import sys; print('ready', flush=True); sys.stdin.read()"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    try:
        assert child.stdout.readline().strip() == b"ready"
        path = tmp_path / "instance.lock"
        path.write_text(dumps({"pid": child.pid, "token": "existing-owner"}), encoding="utf-8")
        with pytest.raises(ConflictError, match="Another backend"):
            BackendInstanceLock(path).acquire()
        with pytest.raises(subprocess.TimeoutExpired):
            child.wait(timeout=0.2)
        assert "existing-owner" in path.read_text(encoding="utf-8")
    finally:
        child.kill()
        child.communicate(timeout=2)
