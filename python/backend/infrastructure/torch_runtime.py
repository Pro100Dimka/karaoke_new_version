"""PyTorch builds the app places itself.

The installer carries the CPU build of PyTorch: the CUDA build is 2.6 GB and would not fit a
GitHub release. On a computer with an NVIDIA GPU the backend downloads the CUDA build once, in the
background, into the user's profile (``prepare_gpu_build``); every process it starts afterwards
(the PyTorch probe, the AI worker of each job) imports it, so nobody has to restart anything.
Every wheel is pinned by URL and SHA-256 and verified before it is unpacked.

    python -m backend.infrastructure.torch_runtime install-gpu <target-dir>    (by hand)
    python -m backend.infrastructure.torch_runtime bundle-cpu <site-packages> <download-cache>
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import sys
import threading
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import unquote

from backend.domain_errors import DependencyError
from backend.infrastructure.job_executor import run_in_background
from backend.infrastructure.process_runner import ProcessRunner

logger = logging.getLogger(__name__)

TORCH_VERSION = "2.11.0"
PYTHON_TAG = "cp313"
COMPLETE_MARKER = ".complete"
_INDEX = "https://download.pytorch.org/whl"
_CHUNK = 1 << 20
_OLD_DIST_INFO = re.compile(r"^(torch|torchaudio)-[^-]+\.dist-info$")


@dataclass(frozen=True)
class Wheel:
    url: str
    sha256: str

    @property
    def file_name(self) -> str:
        return unquote(self.url.rsplit("/", 1)[-1])


def _wheel(variant: str, package: str, sha256: str) -> Wheel:
    name = f"{package}-{TORCH_VERSION}%2B{variant}-{PYTHON_TAG}-{PYTHON_TAG}-win_amd64.whl"
    return Wheel(f"{_INDEX}/{variant}/{name}", sha256)


CPU_WHEELS = (
    _wheel("cpu", "torch", "ed70d4a4fc9f8b826c02fa1a9800a83820fb2fa6ae607680b53390f9ef394d85"),
    _wheel("cpu", "torchaudio", "fa0c22f58f60c3537b7d28ed2501e0995acb2a65d9af2708f21edaad67186cd8"),
)
GPU_WHEELS = (
    _wheel("cu130", "torch", "339801f2163698a53c7fb3c91883e7f44331d22c34d45acfbce4eff71f2332fa"),
    _wheel(
        "cu130", "torchaudio", "ce09a7b144b7982b46c8fe399cf5f91d43dda571e9d6ddba67e928567551f614"
    ),
)

LEGACY_GPU_WHEELS = (
    _wheel("cu126", "torch", "12f7f1b73ba522576ea2050fbe2dc720a30cf681c73b8ea2d4f5480d66fad8f3"),
    _wheel(
        "cu126", "torchaudio", "bb5d55842b8b52ab7a67a6bd0ec23b56dfca4f163e8d2e053d6a24a8192f46c0"
    ),
)


def select_gpu_runtime(target: Path) -> Path:
    """CUDA 13 requires SM 7.5; the CUDA 12.6 build retains older architectures."""
    try:
        result = ProcessRunner().run(
            ["nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader"],
            timeout_seconds=15,
        )
        rows = result.stdout.decode("utf-8", errors="replace").splitlines()
        capability = float(rows[0]) if result.exit_code == 0 and rows else 0
    except (DependencyError, ValueError):
        return target
    return target.with_name(f"torch-{TORCH_VERSION}-cu126") if 0 < capability < 7.5 else target


def gpu_wheels(target: Path) -> tuple[Wheel, ...]:
    return LEGACY_GPU_WHEELS if target.name.endswith("-cu126") else GPU_WHEELS


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def download(wheel: Wheel, cache: Path) -> Path:
    """The wheel in `cache`, downloaded unless a verified copy is already there."""
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / wheel.file_name
    if target.is_file() and _sha256(target) == wheel.sha256:
        return target
    partial = target.with_name(target.name + ".part")
    digest = hashlib.sha256()
    with urllib.request.urlopen(wheel.url, timeout=60) as response, partial.open("wb") as stream:
        while chunk := response.read(_CHUNK):
            digest.update(chunk)
            stream.write(chunk)
    if digest.hexdigest() != wheel.sha256:
        partial.unlink(missing_ok=True)
        raise ValueError(f"{wheel.file_name}: SHA-256 does not match")
    partial.replace(target)
    return target


def _top_level_names(wheel: Path) -> set[str]:
    with zipfile.ZipFile(wheel) as archive:
        return {name.split("/", 1)[0] for name in archive.namelist()}


def _remove(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def unpack(wheels: list[Path], destination: Path) -> None:
    """Unpacks wheels into `destination`, replacing what they provide and older torch metadata."""
    destination.mkdir(parents=True, exist_ok=True)
    for entry in destination.iterdir():
        if _OLD_DIST_INFO.match(entry.name):
            _remove(entry)
    for wheel in wheels:
        for name in _top_level_names(wheel):
            _remove(destination / name)
        with zipfile.ZipFile(wheel) as archive:
            archive.extractall(destination)


def install_gpu(target: Path, *, verified_wheels: list[Path] | None = None) -> None:
    """Downloads and unpacks the CUDA build into `target`, which counts only once complete."""
    if (target / COMPLETE_MARKER).is_file():
        return
    cache = target.parent / "downloads"
    partial = target.with_name(target.name + ".partial")
    _remove(partial)
    wheels = (
        verified_wheels
        if verified_wheels is not None
        else [download(wheel, cache) for wheel in gpu_wheels(target)]
    )
    unpack(wheels, partial)
    (partial / COMPLETE_MARKER).write_text(TORCH_VERSION, encoding="utf-8")
    _remove(target)
    partial.replace(target)
    shutil.rmtree(cache, ignore_errors=True)


def use_gpu_build(target: Path) -> bool:
    """Puts a complete CUDA build first on the import path of every process started from now on."""
    if not (target / COMPLETE_MARKER).is_file():
        return False
    current = os.environ.get("PYTHONPATH", "")
    paths = [path for path in current.split(os.pathsep) if path]
    if str(target) not in paths:
        os.environ["PYTHONPATH"] = os.pathsep.join([str(target), *paths])
    return True


def has_nvidia_gpu() -> bool:
    """An NVIDIA GPU with its driver: ``nvidia-smi -L`` lists it ("GPU 0: ...")."""
    try:
        result = ProcessRunner().run(["nvidia-smi", "-L"], timeout_seconds=15)
    except DependencyError:
        return False
    return (
        result.exit_code == 0 and re.search(rb"^GPU \d+:", result.stdout, re.MULTILINE) is not None
    )


def prepare_gpu_build(
    target: Path, on_ready: Callable[[], None], *, has_gpu: Callable[[], bool] = has_nvidia_gpu
) -> threading.Thread | None:
    """Uses the CUDA build if it is there; on an NVIDIA computer without it, fetches it in the background.

    Jobs run on the CPU until it is ready; `on_ready` then lets the next job find the GPU. A failed
    download is tried again at the next start.
    """
    target = select_gpu_runtime(target)
    if use_gpu_build(target) or not has_gpu():
        return None

    def fetch() -> None:
        try:
            install_gpu(target)
        except (OSError, ValueError, zipfile.BadZipFile):
            logger.warning("CUDA build of PyTorch could not be fetched", exc_info=True)
            return
        use_gpu_build(target)
        logger.info("CUDA build of PyTorch is ready", extra={"path": str(target)})
        on_ready()

    return run_in_background("gpu-runtime", fetch)


def bundle_cpu(site_packages: Path, cache: Path) -> None:
    """Puts the CPU build into a release's site-packages in place of whatever build is there."""
    if all(
        (site_packages / f"{package}-{TORCH_VERSION}+cpu.dist-info").is_dir()
        for package in ("torch", "torchaudio")
    ):
        return
    unpack([download(wheel, cache) for wheel in CPU_WHEELS], site_packages)


def main(arguments: list[str]) -> int:
    if len(arguments) == 2 and arguments[0] == "install-gpu":
        install_gpu(select_gpu_runtime(Path(arguments[1])))
        return 0
    if len(arguments) == 3 and arguments[0] == "bundle-cpu":
        bundle_cpu(Path(arguments[1]), Path(arguments[2]))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
