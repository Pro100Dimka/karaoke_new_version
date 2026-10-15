"""Builds a small C++20 check program with g++/clang++, or with MSVC on Windows.

The extracted-source regressions in this folder used to be skipped on Windows developer machines
without a GNU-style compiler; MSVC is found through vswhere so they really run there.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess


def _vcvars() -> Path | None:
    vswhere = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / \
        "Microsoft Visual Studio/Installer/vswhere.exe"
    if not vswhere.exists():
        return None
    found = subprocess.run(
        [str(vswhere), "-latest", "-products", "*", "-requires",
         "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
        capture_output=True, text=True,
    ).stdout.strip()
    vcvars = Path(found) / "VC/Auxiliary/Build/vcvars64.bat" if found else None
    return vcvars if vcvars and vcvars.exists() else None


def available() -> bool:
    return bool(shutil.which("g++") or shutil.which("clang++") or _vcvars())


def build(sources: list[Path], output: Path,
          includes: list[Path] = ()) -> subprocess.CompletedProcess[str]:
    """Compiles `sources` into the executable `output` (".exe" is added for MSVC)."""
    compiler = shutil.which("g++") or shutil.which("clang++")
    if compiler:
        flags = ["-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror"]
        command = [compiler, *flags, *[f"-I{path}" for path in includes],
                   *map(str, sources), "-o", str(output)]
        return subprocess.run(command, capture_output=True, text=True, timeout=120)
    vcvars = _vcvars()
    if vcvars is None:
        raise RuntimeError("no C++20 compiler")
    # Warnings stay visible but not fatal: the harnesses were written against GCC/Clang -Wall,
    # and MSVC's narrowing warnings on their literals are not findings about production code.
    cl = " ".join([
        "cl /nologo /std:c++20 /O2 /EHsc /W3",
        *[f'/I"{path}"' for path in includes], *[f'"{source}"' for source in sources],
        f'/Fe"{output.with_suffix(".exe")}"', f'/Fo"{output.parent}\\\\"',
    ])
    return subprocess.run(f'call "{vcvars}" >nul && {cl}', shell=True, capture_output=True,
                          text=True, timeout=300, cwd=output.parent)


def executable(output: Path) -> Path:
    exe = output.with_suffix(".exe")
    return exe if exe.exists() else output
