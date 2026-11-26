# SPDX-License-Identifier: GPL-3.0-or-later
"""Package the exact sources and license notices of the locally built FFmpeg tools."""

import hashlib
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path


def sha256(file: Path) -> str:
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_text(file: Path) -> str:
    raw = file.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def main() -> None:
    sources, work, output = (Path(value).resolve(strict=True) for value in sys.argv[1:])
    root = Path(__file__).resolve().parents[1]
    docs = root / "docs/third-party/ffmpeg"
    archives = []
    for line in (docs / "sources.sha256").read_text().splitlines():
        expected, name = line.split(maxsplit=1)
        if sha256(sources / name) != expected.lower():
            raise ValueError(f"Source archive changed: {name}")
        archives.append(name)
    binaries = {
        name: sha256(output / "bin" / name) for name in ["ffmpeg.exe", "ffprobe.exe"]
    }
    sections = []
    seen = set()
    source_folders = [
        work / name
        for name in [
            "ffmpeg-8.1.2",
            "lame-3.100",
            "rubberband-1.8.1",
            "fftw-3.3.10",
            "libsamplerate-0.2.2",
            "zlib-1.3.1",
        ]
    ]
    for folder in source_folders:
        for file in sorted(folder.rglob("*")):
            if not file.is_file():
                continue
            if file.name.startswith(("COPYING", "LICENSE", "COPYRIGHT")):
                text = source_text(file)
            elif file.suffix.lower() in [".c", ".h", ".cpp", ".s", ".asm"]:
                raw = source_text(file)
                comments = re.match(
                    r"\s*((?:(?:/\*.*?\*/|//[^\n]*|;[^\n]*)\s*)+)", raw, re.DOTALL
                )
                text = (
                    comments[1]
                    if comments
                    and re.search(r"copyright|permission|licen[cs]e", comments[1], re.IGNORECASE)
                    else ""
                )
            else:
                continue
            if text and text not in seen:
                seen.add(text)
                sections.append(
                    f"===== {file.relative_to(work).as_posix()} =====\n{text}"
                )
    toolchain_licenses = Path(work.anchor) / "Caches/msys2/msys64/ucrt64/share/licenses"
    for library in ["crt", "libgcc", "libstdc++", "libwinpthread", "winpthreads"]:
        for file in sorted((toolchain_licenses / library).iterdir()):
            if file.is_file():
                sections.append(
                    f"===== compiler runtime: {library}/{file.name} =====\n{file.read_text(encoding='utf-8')}"
                )
    notices = output / "FFmpeg-8.1.2-advoice1-THIRD-PARTY-NOTICES.txt"
    notices.write_text("\n\n".join(sections) + "\n", encoding="utf-8")
    shutil.copyfile(work / "ffmpeg-8.1.2/COPYING.GPLv3", docs / "GPL-3.0.txt")
    shutil.copyfile(output / "BUILD-INFO.txt", docs / "BUILD-INFO.txt")
    manifest = {
        "version": "8.1.2-advoice1",
        "license": "GPL-3.0-or-later",
        "upstreamUrl": "https://ffmpeg.org/",
        "binaries": binaries,
        "inputs": {name: sha256(sources / name) for name in archives},
        "sourcePatches": [],
    }
    archive = output / "FFmpeg-8.1.2-advoice1-corresponding-source.zip"
    with zipfile.ZipFile(
        archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6
    ) as bundle:
        for name in archives:
            bundle.write(sources / name, "sources/" + name)
        for file, target in [
            (root / "scripts/build-ffmpeg.sh", "scripts/build-ffmpeg.sh"),
            (Path(__file__), "scripts/package-ffmpeg.py"),
            (docs / "sources.sha256", "docs/third-party/ffmpeg/sources.sha256"),
            (docs / "README.md", "docs/third-party/ffmpeg/README.md"),
            (output / "BUILD-INFO.txt", "BUILD-INFO.txt"),
            (output / "runtime-dlls.txt", "runtime-dlls.txt"),
            (notices, "THIRD-PARTY-NOTICES.txt"),
            (docs / "GPL-3.0.txt", "COPYING.GPLv3"),
            (work / "ffmpeg-8.1.2/config.h", "configuration/ffmpeg.config.h"),
            (
                work / "ffmpeg-8.1.2/ffbuild/config.mak",
                "configuration/ffmpeg.config.mak",
            ),
        ]:
            bundle.write(file, target)
        bundle.writestr("build-manifest.json", json.dumps(manifest, indent=2) + "\n")
    approved = {
        key: value
        for key, value in manifest.items()
        if key not in ["inputs", "sourcePatches"]
    }
    approved["sourceArchive"] = {"name": archive.name, "sha256": sha256(archive)}
    approved["thirdPartyNotices"] = {"name": notices.name, "sha256": sha256(notices)}
    (docs / "distribution.json").write_text(
        json.dumps(approved, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(approved, indent=2))


if __name__ == "__main__":
    main()
