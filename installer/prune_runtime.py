"""Remove build and development artifacts from the staged offline Python runtime."""

from __future__ import annotations

from pathlib import Path
import shutil
import sys


BUILD_ONLY_SUFFIXES = {".h", ".hpp", ".lib", ".pyc", ".pyo"}
DEVELOPMENT_PACKAGES = ("_pytest", "pytest", "mypy", "mypyc", "ruff", "pip", "wheel")


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(file.stat().st_size for file in path.rglob("*") if file.is_file())


def _remove(path: Path) -> int:
    if not path.exists():
        return 0
    removed = _size(path)
    if path.is_dir():
        shutil.rmtree(path)
    else:
        path.unlink()
    return removed


def main() -> None:
    resources = Path(sys.argv[1]).resolve(strict=True)
    site_packages = resources / "python-runtime" / "Lib" / "site-packages"
    if not site_packages.is_dir():
        raise SystemExit(f"Bundled site-packages does not exist: {site_packages}")

    removed = 0
    for bytecode in tuple(site_packages.rglob("__pycache__")):
        removed += _remove(bytecode)
    for path in tuple(site_packages.rglob("*")):
        if path.is_file() and path.suffix.lower() in BUILD_ONLY_SUFFIXES:
            removed += _remove(path)

    for package in DEVELOPMENT_PACKAGES:
        removed += _remove(site_packages / package)
        for metadata in site_packages.glob(f"{package}-*.dist-info"):
            removed += _remove(metadata)

    for directory in sorted(
        (path for path in site_packages.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        try:
            directory.rmdir()
        except OSError:
            pass

    print(f"Pruned {removed / (1024 * 1024):.1f} MiB of build-only Python artifacts")


if __name__ == "__main__":
    main()
