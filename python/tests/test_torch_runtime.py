from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path

import pytest

from backend.infrastructure import torch_runtime
from backend.infrastructure.torch_runtime import COMPLETE_MARKER, Wheel, download, install_gpu, unpack


def _wheel_file(path: Path, files: dict[str, str]) -> Wheel:
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return Wheel(path.as_uri(), hashlib.sha256(path.read_bytes()).hexdigest())


def test_pinned_wheels_match_the_bundled_python() -> None:
    for wheels in (torch_runtime.CPU_WHEELS, torch_runtime.GPU_WHEELS):
        for wheel in wheels:
            assert wheel.url.startswith("https://download.pytorch.org/whl/")
            assert f"{torch_runtime.TORCH_VERSION}+" in wheel.file_name
            assert "-cp313-cp313-win_amd64.whl" in wheel.file_name
            assert len(wheel.sha256) == 64


def test_download_rejects_a_wheel_whose_hash_does_not_match(tmp_path: Path) -> None:
    good = _wheel_file(tmp_path / "torch.whl", {"torch/__init__.py": "x"})
    with pytest.raises(ValueError, match="SHA-256"):
        download(Wheel(good.url, "0" * 64), tmp_path / "cache")
    assert not list((tmp_path / "cache").iterdir())
    assert download(good, tmp_path / "cache").read_bytes() == (tmp_path / "torch.whl").read_bytes()


def test_unpack_replaces_the_torch_build_and_leaves_other_packages(tmp_path: Path) -> None:
    site = tmp_path / "site"
    (site / "torch" / "lib").mkdir(parents=True)
    (site / "torch" / "lib" / "cublasLt64_13.dll").write_text("cuda", encoding="utf-8")
    (site / "torch-2.11.0+cu130.dist-info").mkdir()
    (site / "torchcrepe").mkdir()
    wheel = tmp_path / "torch-cpu.whl"
    _wheel_file(wheel, {"torch/__init__.py": "cpu", "torch-2.11.0+cpu.dist-info/METADATA": "m"})

    unpack([wheel], site)

    assert not (site / "torch" / "lib").exists()
    assert (site / "torch" / "__init__.py").read_text(encoding="utf-8") == "cpu"
    assert not (site / "torch-2.11.0+cu130.dist-info").exists()
    assert (site / "torch-2.11.0+cpu.dist-info").is_dir()
    assert (site / "torchcrepe").is_dir()


def test_gpu_build_counts_only_once_complete(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sources = tmp_path / "sources"
    sources.mkdir()
    wheels = (
        _wheel_file(sources / "torch.whl", {"torch/__init__.py": "cuda"}),
        _wheel_file(sources / "torchaudio.whl", {"torchaudio/__init__.py": "cuda"}),
    )
    monkeypatch.setattr(torch_runtime, "GPU_WHEELS", wheels)
    target = tmp_path / "gpu-runtime" / "torch-cu130"

    install_gpu(target)

    assert (target / COMPLETE_MARKER).is_file()
    assert (target / "torch" / "__init__.py").read_text(encoding="utf-8") == "cuda"
    assert (target / "torchaudio").is_dir()
    assert not (tmp_path / "gpu-runtime" / "downloads").exists()
    assert not target.with_name(target.name + ".partial").exists()
